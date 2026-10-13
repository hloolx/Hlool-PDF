FROM node:24-bookworm-slim AS web
ARG HTTP_PROXY
ARG HTTPS_PROXY
WORKDIR /src
COPY web/package*.json ./web/
RUN npm --prefix web ci --no-audit --no-fund
COPY web ./web
RUN npm --prefix web run build

# Static files only: no PDF processing API, account service or data volume.
FROM nginx:stable-alpine
COPY deploy/nginx-static.conf /etc/nginx/conf.d/default.conf
COPY --from=web /src/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
