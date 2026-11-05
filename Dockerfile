# Medcius 前置机生产镜像（缺口六：运行时产品形态）
# CPU NER is mandatory. Install exactly the committed lockfile; no install hooks
# or optional GPU downloads. Native ONNX binaries require a glibc runtime.
# 安全基线：非 root 运行、固定版本基镜像（发布时按 digest 钉死，见下方注释）、健康检查、
# 数据/密钥全部经挂载注入（不进镜像层）。
# 发布钉死示例（以实际验收 digest 替换）：
#   FROM node:22.14.0-bookworm-slim@sha256:<release-digest>
FROM node:22.14.0-bookworm-slim
LABEL org.medcius.image="medcius" org.medcius.version="1.0.0" org.medcius.sbom="pending-syft"

RUN groupadd --system medcius && useradd --system --gid medcius medcius \
    && mkdir -p /opt/medcius/data /opt/medcius/backups \
    && chown -R medcius:medcius /opt/medcius

WORKDIR /opt/medcius/app

# Resolve native dependencies for this image platform, never copy host node_modules.
COPY plugins/medcius/runtimes/cn-phi-ner/package*.json ./plugins/medcius/runtimes/cn-phi-ner/
RUN npm ci --prefix plugins/medcius/runtimes/cn-phi-ner --ignore-scripts --omit=dev --no-audit --no-fund

# 测试/文档/合规文书/实验区不进生产镜像
COPY scripts ./scripts
COPY plugins ./plugins

ENV NODE_ENV=production \
    MEDCIUS_PROFILE=production \
    NODE_NO_WARNINGS=1 \
    PORT=8080 \
    HOST=0.0.0.0 \
    CLAUDE_MEDCIUS_DATA=/opt/medcius/data \
    MEDCIUS_CN_NER_MODEL_DIR=/opt/medcius/models/bert-base-chinese-ner-int8

USER medcius
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.mjs

CMD ["node", "scripts/serve.mjs"]
