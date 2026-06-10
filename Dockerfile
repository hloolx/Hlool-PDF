FROM node:24-bookworm-slim AS web
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
WORKDIR /src
COPY web/package*.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

FROM golang:1.26-bookworm AS build
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -tags embed -trimpath -ldflags="-s -w" -o /out/hlool-pdf ./cmd/hlool-pdf

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent hlool \
    && mkdir -p /data \
    && chown -R 10001:10001 /data
COPY --from=build /out/hlool-pdf /usr/local/bin/hlool-pdf
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
ENV HLOOL_MODE=web
ENV HLOOL_ADDR=0.0.0.0:8080
ENV HLOOL_DATA_DIR=/data
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["hlool-pdf"]
