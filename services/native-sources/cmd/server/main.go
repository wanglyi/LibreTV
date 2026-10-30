package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"duanjuapp/native/core"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var sources = map[string]string{"hongguo": "红果短剧", "hanxiaoquan": "韩小圈", "guipian": "鬼片影视"}
var numericID = regexp.MustCompile(`^[0-9]{1,32}$`)
var mediaFile = regexp.MustCompile(`^(index\.m3u8|seg[0-9]{6}\.ts)$`)

type ticket struct {
	Source  string `json:"s"`
	ID      string `json:"id"`
	Episode int    `json:"ep"`
	Expires int64  `json:"exp"`
}
type cachedDetail struct {
	detail  core.WebDetail
	expires time.Time
}
type job struct {
	dir        string
	ready      chan struct{}
	done       chan struct{}
	cancel     context.CancelFunc
	lastUsed   time.Time
	retryAfter time.Time
	err        error
	finished   bool
	readyOnce  sync.Once
}
type server struct {
	gateway  *core.WebGateway
	token    string
	site     string
	root     string
	ffmpeg   string
	maxBytes int64
	mu       sync.Mutex
	details  map[string]cachedDetail
	jobs     map[string]*job
	slots    chan struct{}
}

func main() {
	token := os.Getenv("SOURCE_TOKEN")
	if len(token) < 32 {
		log.Fatal("SOURCE_TOKEN must contain at least 32 characters")
	}
	site := strings.TrimRight(os.Getenv("PUBLIC_SITE_URL"), "/")
	parsed, err := url.Parse(site)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1") || parsed.User != nil || parsed.Path != "" {
		log.Fatal("PUBLIC_SITE_URL must be a site origin")
	}
	root, _ := filepath.Abs(env("DATA_DIR", "./data"))
	if err = os.MkdirAll(filepath.Join(root, "streams"), 0700); err != nil {
		log.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "streams"))
	cacheName := regexp.MustCompile(`^[a-f0-9]{32}$`)
	for _, entry := range entries {
		if entry.IsDir() && cacheName.MatchString(entry.Name()) {
			if err := os.RemoveAll(filepath.Join(root, "streams", entry.Name())); err != nil {
				log.Fatal(err)
			}
		}
	}
	gateway, err := core.NewWebGateway(filepath.Join(root, "core"))
	if err != nil {
		log.Fatal(err)
	}
	ffmpeg, err := exec.LookPath(env("FFMPEG_PATH", "ffmpeg"))
	if err != nil {
		log.Fatal("FFmpeg unavailable")
	}
	app := &server{gateway: gateway, token: token, site: site, root: root, ffmpeg: ffmpeg, maxBytes: int64(envInt("CACHE_MAX_MB", 2048, 128, 16384)) << 20, details: map[string]cachedDetail{}, jobs: map[string]*job{}, slots: make(chan struct{}, envInt("MAX_ACTIVE_JOBS", 1, 1, 4))}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go app.cleanup(ctx)
	httpServer := &http.Server{Addr: env("LISTEN_ADDR", "127.0.0.1:3987"), Handler: app, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		app.mu.Lock()
		for _, j := range app.jobs {
			j.cancel()
		}
		app.mu.Unlock()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpServer.Shutdown(shutdown)
	}()
	log.Printf("native sources ready on %s", httpServer.Addr)
	if err = httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func envInt(key string, fallback, min, max int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value < min || value > max {
		return fallback
	}
	return value
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]any{"code": status, "msg": message, "list": []any{}})
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/healthz" {
		reply(w, 200, map[string]any{"ok": true, "sources": sources})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Source-Token")), []byte(s.token)) != 1 {
		fail(w, 401, "Unauthorized")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		fail(w, 405, "Method not allowed")
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 2 && parts[0] == "vod" {
		s.vod(w, r, parts[1])
		return
	}
	if len(parts) == 3 && parts[0] == "play" {
		s.play(w, r, parts[1], parts[2])
		return
	}
	fail(w, 404, "Not found")
}

func (s *server) encodeTicket(t ticket) string {
	body, _ := json.Marshal(t)
	payload := base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(s.token))
	mac.Write([]byte("play:" + payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *server) decodeTicket(raw string) (ticket, error) {
	var value ticket
	if len(raw) > 768 {
		return value, errors.New("Invalid playback ticket")
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return value, errors.New("Invalid playback ticket")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return value, err
	}
	mac := hmac.New(sha256.New, []byte(s.token))
	mac.Write([]byte("play:" + parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return value, errors.New("Invalid playback ticket")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return value, err
	}
	if json.Unmarshal(body, &value) != nil || sources[value.Source] == "" || !numericID.MatchString(value.ID) || value.Episode < 0 || value.Episode > 9999 || value.Expires < time.Now().Unix() || value.Expires > time.Now().Add(13*time.Hour).Unix() {
		return value, errors.New("播放地址已过期，请重新打开详情")
	}
	return value, nil
}

func (s *server) getDetail(ctx context.Context, source, id string) (core.WebDetail, error) {
	key := source + ":" + id
	s.mu.Lock()
	cached, found := s.details[key]
	s.mu.Unlock()
	if found && time.Now().Before(cached.expires) {
		return cached.detail, nil
	}
	detail, err := s.gateway.Detail(ctx, source, id)
	if err != nil {
		return detail, err
	}
	s.mu.Lock()
	if len(s.details) > 256 {
		s.details = map[string]cachedDetail{}
	}
	s.details[key] = cachedDetail{detail, time.Now().Add(20 * time.Minute)}
	s.mu.Unlock()
	return detail, nil
}

func vodRow(drama core.WebDrama) map[string]any {
	return map[string]any{"vod_id": drama.SourceID, "vod_name": drama.Title, "vod_pic": drama.Cover, "vod_content": drama.Description, "type_name": drama.Category, "vod_remarks": fmt.Sprintf("共 %d 集", drama.Episodes), "vod_year": "", "vod_area": "", "vod_actor": "", "vod_director": ""}
}
func (s *server) vod(w http.ResponseWriter, r *http.Request, source string) {
	if sources[source] == "" {
		fail(w, 404, "未知站源")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if id := r.URL.Query().Get("ids"); id != "" {
		if !numericID.MatchString(id) {
			fail(w, 400, "无效剧集 ID")
			return
		}
		detail, err := s.getDetail(ctx, source, id)
		if err != nil {
			fail(w, 502, err.Error())
			return
		}
		row := vodRow(detail.Drama)
		episodes := make([]string, 0, len(detail.Chapters))
		expiry := time.Now().Add(12 * time.Hour).Unix()
		for index := range detail.Chapters {
			capability := s.encodeTicket(ticket{source, id, index, expiry})
			episodes = append(episodes, fmt.Sprintf("第%d集$%s/api/native/play/%s/index.m3u8", index+1, s.site, capability))
		}
		row["vod_play_url"] = strings.Join(episodes, "#")
		row["vod_play_from"] = sources[source]
		reply(w, 200, map[string]any{"code": 200, "page": 1, "pagecount": 1, "list": []any{row}})
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("wd"))
	if len([]rune(query)) > 80 {
		fail(w, 400, "搜索词过长")
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("pg"))
	if page < 1 {
		page = 1
	}
	if page > 5 {
		fail(w, 400, "页码超出范围")
		return
	}
	result, err := s.gateway.Catalog(ctx, source, query, page)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	rows := make([]map[string]any, 0, len(result.Items))
	for _, drama := range result.Items {
		rows = append(rows, vodRow(drama))
	}
	reply(w, 200, map[string]any{"code": 200, "page": page, "pagecount": 1, "list": rows, "msg": result.Warning})
}

func (s *server) getJob(t ticket) (*job, error) {
	identity := fmt.Sprintf("%s:%s:%d", t.Source, t.ID, t.Episode)
	digest := sha256.Sum256([]byte(identity))
	key := hex.EncodeToString(digest[:16])
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.jobs[key]; current != nil {
		if current.finished && current.err != nil && time.Now().After(current.retryAfter) {
			os.RemoveAll(current.dir)
			delete(s.jobs, key)
		} else {
			current.lastUsed = time.Now()
			return current, nil
		}
	}
	select {
	case s.slots <- struct{}{}:
	default:
		return nil, errors.New("正在准备其他视频，请稍后重试")
	}
	if folderSize(filepath.Join(s.root, "streams")) >= s.maxBytes {
		<-s.slots
		return nil, errors.New("视频缓存暂满，请稍后重试")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	current := &job{dir: filepath.Join(s.root, "streams", key), ready: make(chan struct{}), done: make(chan struct{}), cancel: cancel, lastUsed: time.Now()}
	s.jobs[key] = current
	go s.runJob(ctx, current, t)
	return current, nil
}

func (s *server) finishJob(j *job, err error) {
	s.mu.Lock()
	j.err = err
	j.finished = true
	j.retryAfter = time.Now().Add(10 * time.Second)
	s.mu.Unlock()
	j.readyOnce.Do(func() { close(j.ready) })
	<-s.slots
	close(j.done)
}
func (s *server) runJob(ctx context.Context, j *job, t ticket) {
	if err := os.MkdirAll(j.dir, 0700); err != nil {
		s.finishJob(j, err)
		return
	}
	detail, err := s.getDetail(ctx, t.Source, t.ID)
	if err != nil {
		s.finishJob(j, err)
		return
	}
	if t.Episode >= len(detail.Chapters) {
		s.finishJob(j, errors.New("分集不存在，请刷新详情"))
		return
	}
	if detail.Chapters[t.Episode].VIP {
		s.finishJob(j, errors.New("该分集需要源站授权"))
		return
	}
	plan, err := s.gateway.Play(ctx, detail, t.Episode)
	if err != nil {
		s.finishJob(j, err)
		return
	}
	defer s.gateway.Release(plan.Session)
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-rw_timeout", "15000000", "-protocol_whitelist", "http,https,tcp,tls,crypto,data"}
	if plan.Key != "" {
		args = append(args, "-decryption_key", plan.Key)
	}
	args = append(args, "-i", plan.URL, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-threads", "1", "-f", "hls", "-hls_time", "4", "-hls_list_size", "0", "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file", "-hls_segment_filename", filepath.Join(j.dir, "seg%06d.ts"), filepath.Join(j.dir, "index.m3u8"))
	command := exec.CommandContext(ctx, s.ffmpeg, args...)
	var diagnostic bytes.Buffer
	command.Stdout = io.Discard
	command.Stderr = &diagnostic
	if err = command.Start(); err != nil {
		s.finishJob(j, errors.New("无法启动视频准备服务"))
		return
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	checkBudget := time.NewTicker(5 * time.Second)
	defer checkBudget.Stop()
	for {
		select {
		case err = <-done:
			if err != nil {
				message := strings.TrimSpace(diagnostic.String())
				if len(message) > 4000 {
					message = message[len(message)-4000:]
				}
				log.Printf("video preparation failed source=%s id=%s episode=%d error=%v detail=%s", t.Source, t.ID, t.Episode+1, err, message)
				err = errors.New("视频准备失败，请重新获取播放地址或换一集")
			}
			s.finishJob(j, err)
			return
		case <-ticker.C:
			if body, e := os.ReadFile(filepath.Join(j.dir, "index.m3u8")); e == nil && strings.Contains(string(body), "#EXTINF:") {
				j.readyOnce.Do(func() { close(j.ready) })
			}
		case <-checkBudget.C:
			if folderSize(filepath.Join(s.root, "streams")) > s.maxBytes {
				j.cancel()
			}
		}
	}
}

func (s *server) play(w http.ResponseWriter, r *http.Request, raw, file string) {
	if !mediaFile.MatchString(file) {
		fail(w, 404, "媒体文件不存在")
		return
	}
	value, err := s.decodeTicket(raw)
	if err != nil {
		fail(w, 401, err.Error())
		return
	}
	current, err := s.getJob(value)
	if err != nil {
		w.Header().Set("Retry-After", "5")
		fail(w, 429, err.Error())
		return
	}
	select {
	case <-current.ready:
	case <-r.Context().Done():
		return
	case <-time.After(8 * time.Second):
		w.Header().Set("Retry-After", "3")
		fail(w, 503, "视频仍在准备，请稍后重试")
		return
	}
	s.mu.Lock()
	jobErr := current.err
	s.mu.Unlock()
	if jobErr != nil {
		fail(w, 502, jobErr.Error())
		return
	}
	target := filepath.Join(current.dir, file)
	if _, err = os.Stat(target); err != nil {
		if jobErr != nil {
			fail(w, 502, jobErr.Error())
		} else {
			fail(w, 404, "视频分片尚未准备好")
		}
		return
	}
	if file == "index.m3u8" {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "private, max-age=60")
	}
	http.ServeFile(w, r, target)
}

func folderSize(root string) int64 {
	var total int64
	filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if info, e := entry.Info(); e == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}
func (s *server) cleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			var removed []*job
			s.mu.Lock()
			for key, j := range s.jobs {
				if time.Since(j.lastUsed) > 20*time.Minute {
					j.cancel()
					removed = append(removed, j)
					delete(s.jobs, key)
				}
			}
			s.mu.Unlock()
			for _, j := range removed {
				<-j.done
				os.RemoveAll(j.dir)
			}
		}
	}
}

func randomToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
