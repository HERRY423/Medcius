# Medcius 前置机生产镜像（缺口六：运行时产品形态）
# 零第三方依赖（node:http / better-sqlite3 均为本地源码或内建），镜像只含运行所需文件。
# 安全基线：非 root 运行、固定版本基镜像、健康检查、数据/密钥全部经挂载注入（不进镜像层）。
FROM node:22.14.0-alpine3.21

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
