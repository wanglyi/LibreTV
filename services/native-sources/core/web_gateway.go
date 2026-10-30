package core

import "context"

type WebDrama = nativeDrama
type WebPlan = nativePlan
type WebCatalog = nativeCatalogResult

type WebDetail struct {
	Drama    WebDrama
	Chapters []Chapter
}

type WebGateway struct{ engine *nativeEngine }

func NewWebGateway(directory string) (*WebGateway, error) {
	engine, err := newNativeEngine(directory)
	if err != nil {
		return nil, err
	}
	engine.downloader.cfg.MaxPagesPerSort = 1
	return &WebGateway{engine: engine}, nil
}

func (gateway *WebGateway) Catalog(ctx context.Context, source, query, category string, page int) (WebCatalog, error) {
	return gateway.engine.nativeCatalog(ctx, nativeInput{Source: source, Query: query, Category: category, Page: page})
}

func (gateway *WebGateway) Detail(ctx context.Context, source, id string) (WebDetail, error) {
	result, err := gateway.engine.nativeDetail(ctx, nativeDrama{ID: providerDramaID(source, id), Source: source, SourceID: id})
	if err != nil {
		return WebDetail{}, err
	}
	value := result.(map[string]any)
	return WebDetail{Drama: value["drama"].(nativeDrama), Chapters: value["chapters"].([]Chapter)}, nil
}

func (gateway *WebGateway) Play(ctx context.Context, detail WebDetail, index int) (WebPlan, error) {
	return gateway.engine.nativeResolve(ctx, nativeInput{Drama: detail.Drama, Chapter: detail.Chapters[index], Index: index + 1, Force: true})
}

func (gateway *WebGateway) Release(session string) { gateway.engine.nativeReleasePlayback(session) }
