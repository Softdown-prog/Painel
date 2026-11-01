FROM rust:1.85.1-alpine AS native-build
WORKDIR /build
RUN apk add --no-cache musl-dev
COPY native-runtime/Cargo.toml native-runtime/Cargo.lock ./
COPY native-runtime/src ./src
RUN cargo test --locked --offline && cargo build --release --locked --offline

FROM node:24-alpine
WORKDIR /app
COPY app-wake.mjs host-metrics.ts native-runtime.mjs native-runtime-smoke.mjs ./
COPY --from=native-build --chmod=0555 /build/target/release/panel-runtime /usr/local/bin/panel-runtime
RUN node native-runtime-smoke.mjs
ENV NODE_ENV=production PORT=8082 PANEL_NATIVE_RUNTIME=prefer
EXPOSE 8082
CMD ["node", "app-wake.mjs"]
