FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY core ./core
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X duanjuapp/native/core.buildAllSources=true" -o /native-sources ./cmd/server

FROM alpine:3.22
RUN apk add --no-cache ffmpeg ca-certificates && adduser -D -u 10001 sources
COPY --from=build /native-sources /usr/local/bin/native-sources
RUN mkdir -p /data && chown sources:sources /data
USER sources
ENV LISTEN_ADDR=0.0.0.0:3987 DATA_DIR=/data GOMEMLIMIT=160MiB MAX_ACTIVE_JOBS=1
EXPOSE 3987
ENTRYPOINT ["native-sources"]
