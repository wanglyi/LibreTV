package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTicketRejectsTamperingAndExpiry(t *testing.T) {
	app := &server{token: "unit-test-private-token-01234567890123456789"}
	original := ticket{Source: "hongguo", ID: "123456", Episode: 2, Expires: time.Now().Add(time.Hour).Unix()}
	signed := app.encodeTicket(original)
	decoded, err := app.decodeTicket(signed)
	if err != nil || decoded != original {
		t.Fatalf("ticket roundtrip: %+v %v", decoded, err)
	}
	bad := []string{signed + "x", strings.Repeat("x", 800), app.encodeTicket(ticket{"hongguo", "123456", 2, time.Now().Add(-time.Hour).Unix()}), app.encodeTicket(ticket{"unknown", "123456", 2, time.Now().Add(time.Hour).Unix()}), app.encodeTicket(ticket{"hongguo", "../../etc/passwd", 2, time.Now().Add(time.Hour).Unix()})}
	for _, value := range bad {
		if _, err := app.decodeTicket(value); err == nil {
			t.Fatal("invalid playback capability accepted")
		}
	}
}

func TestOnlyAuthorizedBoundedRoutesAreExposed(t *testing.T) {
	app := &server{token: "unit-test-private-token-01234567890123456789"}
	cases := []struct {
		path, token string
		status      int
	}{
		{"/healthz", "", 200},
		{"/vod/hongguo?wd=example", "", 401},
		{"/vod/unknown", app.token, 404},
		{"/vod/hongguo?ids=../../etc/passwd", app.token, 400},
		{"/play/invalid/private.env", app.token, 404},
		{"/play/invalid/index.m3u8", app.token, 401},
		{"/initialize", app.token, 404},
	}
	for _, test := range cases {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		req.Header.Set("X-Source-Token", test.token)
		response := httptest.NewRecorder()
		app.ServeHTTP(response, req)
		if response.Code != test.status {
			t.Fatalf("%s: %d", test.path, response.Code)
		}
	}
}
