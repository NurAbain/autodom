"""Private raw-image API, one bounded inference slot per GPU, no image persistence."""

import asyncio
import hmac
import json
import multiprocessing
import os
import re
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from typing import NoReturn

from engine import (
    InferenceUnavailable,
    InvalidImage,
    OversizedImage,
    initialize,
    recognize,
)
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.requests import ClientDisconnect

MAX_BYTES = 8 * 1024 * 1024
TOKEN = os.environ.get("AUTODOM_OCR_API_TOKEN", "")
if not re.fullmatch(r"[\x21-\x7e]{32,256}", TOKEN):
    raise RuntimeError(
        "AUTODOM_OCR_API_TOKEN must contain 32-256 non-space ASCII characters"
    )
DEVICE_TEXT = os.environ.get("AUTODOM_OCR_DEVICES", "0,1")
if not re.fullmatch(r"\d+(?:,\d+)*", DEVICE_TEXT):
    raise RuntimeError("AUTODOM_OCR_DEVICES must list GPU indices")
DEVICES = [int(value) for value in DEVICE_TEXT.split(",")]
if len(set(DEVICES)) != len(DEVICES) or not 1 <= len(DEVICES) <= 2:
    raise RuntimeError("Configure one or two distinct GPU devices")
AVAILABLE: asyncio.Queue = asyncio.Queue(maxsize=len(DEVICES))
WORKERS = []
STATUS = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    try:
        for device in DEVICES:
            pool = ProcessPoolExecutor(
                max_workers=1, mp_context=multiprocessing.get_context("spawn")
            )
            WORKERS.append(pool)
            STATUS.append(await loop.run_in_executor(pool, initialize, device))
            AVAILABLE.put_nowait(pool)
        print(json.dumps({"event": "ocr_api_ready", "gpus": DEVICES}), flush=True)
        yield
    finally:
        for pool in WORKERS:
            pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def error(status: int, code: str) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if status == 429:
        headers["Retry-After"] = "2"
    return JSONResponse({"error": code}, status_code=status, headers=headers)


def authorized(request: Request) -> bool:
    values = request.headers.getlist("authorization")
    return len(values) == 1 and hmac.compare_digest(
        values[0].encode(), f"Bearer {TOKEN}".encode()
    )


def worker_lost() -> NoReturn:
    # A broken native executor cannot recover. Let Docker restart only this service.
    print('{"event":"ocr_worker_lost"}', flush=True)
    os._exit(1)


@app.get("/health")
async def health():
    if len(multiprocessing.active_children()) != len(DEVICES):
        worker_lost()
    return JSONResponse(
        {"status": "ok", "workers": STATUS}, headers={"Cache-Control": "no-store"}
    )


@app.post("/v1/ocr/recognize")
async def ocr(request: Request):
    if not authorized(request):
        return error(401, "unauthorized")
    if (
        request.url.query
        or request.headers.get("content-encoding")
        or request.headers.get("transfer-encoding")
    ):
        return error(400, "invalid_request")
    types = request.headers.getlist("content-type")
    if len(types) != 1 or types[0] not in ("image/jpeg", "image/png"):
        return error(415, "unsupported_media_type")
    lengths = request.headers.getlist("content-length")
    if len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,9}", lengths[0]):
        return error(400, "invalid_request")
    length = int(lengths[0])
    if length > MAX_BYTES:
        return error(413, "image_too_large")
    if length < 24:
        return error(400, "invalid_image")
    try:
        pool = AVAILABLE.get_nowait()
    except asyncio.QueueEmpty:
        return error(429, "busy")
    future = None
    try:
        data = bytearray()
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_BYTES:
                    return error(413, "image_too_large")
                data.extend(chunk)
        if len(data) != length:
            return error(400, "invalid_request")
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(pool, recognize, bytes(data), types[0])

        # Cancellation/timeout must not free a GPU while native inference is still running.
        def release(done):
            if not done.cancelled() and isinstance(done.exception(), BrokenProcessPool):
                worker_lost()
            AVAILABLE.put_nowait(pool)

        future.add_done_callback(release)
        result = await asyncio.wait_for(asyncio.shield(future), timeout=25)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    except OversizedImage:
        return error(413, "image_too_large")
    except InvalidImage:
        return error(400, "invalid_image")
    except BrokenProcessPool:
        worker_lost()
    except (TimeoutError, ClientDisconnect):
        return error(503, "unavailable")
    except InferenceUnavailable:
        # No raw exception text, source pixels, OCR text or credentials in logs.
        print('{"event":"ocr_inference_failed"}', flush=True)
        return error(503, "unavailable")
    finally:
        if future is None:
            AVAILABLE.put_nowait(pool)
