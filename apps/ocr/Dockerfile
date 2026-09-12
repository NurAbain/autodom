FROM python:3.11-slim-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ocr
COPY apps/ocr/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/ocr/models.json apps/ocr/fetch_models.py ./
RUN python fetch_models.py
COPY apps/ocr/engine.py apps/ocr/server.py ./
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=1 HOME=/tmp \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility
USER 10001:10001
EXPOSE 8091
CMD ["python", "-m", "uvicorn", "server:app", "--host", "192.168.0.20", "--port", "8091", "--no-access-log", "--no-server-header", "--limit-concurrency", "16", "--timeout-keep-alive", "5", "--timeout-graceful-shutdown", "30"]
