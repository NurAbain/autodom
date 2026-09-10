FROM ghcr.io/astral-sh/uv:0.12.5 AS uv
FROM python:3.12-slim

COPY --from=uv /uv /usr/local/bin/uv
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    AUTODOM_DATA_DIR=/data \
    AUTODOM_BACKUP_DIR=/backups
WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY autodom ./autodom
RUN uv sync --frozen --no-dev --no-editable \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin autodom \
    && mkdir /data /backups \
    && chown autodom:autodom /data /backups \
    && chmod 700 /data /backups

USER 10001:10001
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=3 CMD ["autodom", "health"]
CMD ["autodom", "run"]
