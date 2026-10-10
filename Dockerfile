# Medcius 前置机生产镜像（缺口六：运行时产品形态）
# P0-4 口径：运行代码为 Node 内建模块 + 仓内源码（无 npm install）；如未来引入
# better-sqlite3 等原生依赖，必须经 lockfile 钉死版本并随 SBOM 发布，本注释不得谎称“内建”。
# 安全基线：非 root 运行、固定版本基镜像（发布时按 digest 钉死，见下方注释）、健康检查、
# 数据/密钥全部经挂载注入（不进镜像层）。
# 发布钉死示例（以实际验收 digest 替换）：
#   FROM node:22.14.0-alpine3.21@sha256:<release-digest>
FROM node:22.14.0-alpine3.21
LABEL org.medcius.image="medcius" org.medcius.version="0.8.0-pilot" org.medcius.sbom="pending-syft"

RUN addgroup -S medcius && adduser -S medcius -G medcius \
    && mkdir -p /opt/medcius/data /opt/medcius/backups \
    && chown -R medcius:medcius /opt/medcius

WORKDIR /opt/medcius/app

# 只拷贝运行所需（零第三方依赖，无需 npm install）；测试/文档/合规文书/实验区不进生产镜像
COPY scripts ./scripts
COPY plugins ./plugins

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=8080 \
    HOST=0.0.0.0 \
    CLAUDE_MEDCIUS_DATA=/opt/medcius/data

USER medcius
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
