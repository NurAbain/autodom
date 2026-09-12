"""Pinned Paddle models on CUDA; RapidOCR supplies geometry and CTC decoding only.

No model auto-download, vision LLM, character guessing or VIN-provider calls.
CPU handles image geometry; all three neural models require CUDA at startup.
"""

import io
import json
import math
import warnings
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import yaml
from PIL import Image, ImageOps, UnidentifiedImageError
from rapidocr.ch_ppocr_det.utils import DBPostProcess, DetPreProcess
from rapidocr.ch_ppocr_rec.utils import CTCLabelDecode
from rapidocr.utils.process_img import get_rotate_crop_image

ROOT = Path(__file__).resolve().parent
DETECTOR_SIDE = 1280
MAX_PIXELS = 25_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)
_ENGINE = None


class InvalidImage(Exception):
    pass


class OversizedImage(Exception):
    pass


class InferenceUnavailable(Exception):
    pass


def image_array(data: bytes, media_type: str) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data)) as image:
            expected = "JPEG" if media_type == "image/jpeg" else "PNG"
            if image.format != expected or getattr(image, "n_frames", 1) != 1:
                raise InvalidImage()
            width, height = image.size
            if width > 12000 or height > 12000 or width * height > MAX_PIXELS:
                raise OversizedImage()
            image.load()
            rgb = ImageOps.exif_transpose(image).convert("RGB")
            return cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise OversizedImage() from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise InvalidImage() from error


class OcrEngine:
    def __init__(self, device: int):
        ort.preload_dlls(directory="")
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("CUDA execution provider is required")
        self.sessions = {}
        self.inputs = {}
        configs = {}
        for name in ("det", "rec", "orientation"):
            directory = ROOT / "models" / name
            configs[name] = yaml.safe_load((directory / "inference.yml").read_text())
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.log_severity_level = 3
            session = ort.InferenceSession(
                str(directory / "inference.onnx"),
                sess_options=options,
                providers=[
                    (
                        "CUDAExecutionProvider",
                        {
                            "device_id": device,
                            "gpu_mem_limit": (2048 if name == "det" else 768)
                            * 1024
                            * 1024,
                            "arena_extend_strategy": "kSameAsRequested",
                            "cudnn_conv_algo_search": "HEURISTIC",
                        },
                    )
                ],
            )
            session.disable_fallback()
            if session.get_providers()[0] != "CUDAExecutionProvider":
                raise RuntimeError("Refusing CPU-only OCR session")
            self.sessions[name] = session
            self.inputs[name] = session.get_inputs()[0].name

        det_ops = configs["det"]["PreProcess"]["transform_ops"]
        normalization = next(
            op["NormalizeImage"] for op in det_ops if "NormalizeImage" in op
        )
        self.det_pre = DetPreProcess(
            DETECTOR_SIDE, "max", normalization["mean"], normalization["std"]
        )
        det_post = configs["det"]["PostProcess"]
        self.det_post = DBPostProcess(
            thresh=det_post["thresh"],
            box_thresh=det_post["box_thresh"],
            max_candidates=256,
            unclip_ratio=det_post["unclip_ratio"],
        )
        self.decode = CTCLabelDecode(
            character=configs["rec"]["PostProcess"]["character_dict"]
        )
        orientation_ops = configs["orientation"]["PreProcess"]["transform_ops"]
        self.ori_size = tuple(
            next(
                op["ResizeImage"]["size"]
                for op in orientation_ops
                if "ResizeImage" in op
            )
        )
        ori_norm = next(
            op["NormalizeImage"] for op in orientation_ops if "NormalizeImage" in op
        )
        self.ori_mean = np.asarray(ori_norm["mean"], dtype=np.float32)
        self.ori_std = np.asarray(ori_norm["std"], dtype=np.float32)
        self.ori_scale = ori_norm["scale"]
        # Exercise maximum supported shapes before declaring this GPU ready.
        self.run(
            "det", np.zeros((1, 3, DETECTOR_SIDE, DETECTOR_SIDE), dtype=np.float32)
        )
        self.run("orientation", np.zeros((1, 3, 80, 160), dtype=np.float32))
        prediction = self.run("rec", np.zeros((1, 3, 48, 3200), dtype=np.float32))
        if prediction.shape[-1] != len(self.decode.character):
            raise RuntimeError("Recognition dictionary does not match model output")
        self.device = device

    def run(self, name: str, tensor: np.ndarray) -> np.ndarray:
        return self.sessions[name].run(None, {self.inputs[name]: tensor})[0]

    def recognize(self, data: bytes, media_type: str) -> dict:
        image = image_array(data, media_type)
        prepared = self.det_pre(image)
        if prepared is None:
            return {"lines": []}
        boxes, _ = self.det_post(self.run("det", prepared), image.shape[:2])
        lines = []
        for box in sorted(boxes, key=lambda item: (item[0][1], item[0][0])):
            crop = get_rotate_crop_image(image, np.asarray(box, dtype=np.float32))
            if min(crop.shape[:2]) < 1:
                continue
            # PP-LCNet requires RGB, stretch resize 160x80 and ImageNet normalization.
            orient = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB), self.ori_size)
            orient = (
                orient.astype(np.float32) * self.ori_scale - self.ori_mean
            ) / self.ori_std
            scores = self.run("orientation", orient.transpose(2, 0, 1)[None])[0]
            if int(scores.argmax()) == 1 and float(scores[1]) >= 0.9:
                crop = cv2.rotate(crop, cv2.ROTATE_180)
            # PP-OCRv5 recognition uses BGR, height48, [-1,1] and right zero-padding.
            height, width = crop.shape[:2]
            target_width = min(3200, max(1, math.ceil(48 * width / height)))
            resized = cv2.resize(crop, (target_width, 48)).astype(np.float32)
            tensor = np.zeros((1, 3, 48, max(320, target_width)), dtype=np.float32)
            tensor[0, :, :, :target_width] = (
                resized.transpose(2, 0, 1) / 255 - 0.5
            ) / 0.5
            decoded, _ = self.decode(self.run("rec", tensor))
            text, confidence = decoded[0]
            # Reject, rather than trim, long lines: truncation can manufacture a VIN.
            if (
                text
                and len(text) <= 512
                and math.isfinite(confidence)
                and 0 <= confidence <= 1
            ):
                lines.append({"text": text, "confidence": float(confidence)})
        result = {"lines": lines}
        if len(json.dumps(result, ensure_ascii=False).encode()) > 64 * 1024:
            raise RuntimeError("OCR response exceeds protocol limit")
        return result


def initialize(device: int) -> dict:
    global _ENGINE
    _ENGINE = OcrEngine(device)
    status = {"gpu": device, "provider": "CUDAExecutionProvider"}
    print(json.dumps({"event": "ocr_worker_ready", **status}), flush=True)
    return status


def recognize(data: bytes, media_type: str) -> dict:
    if _ENGINE is None:
        raise InferenceUnavailable()
    try:
        return _ENGINE.recognize(data, media_type)
    except (InvalidImage, OversizedImage):
        raise
    except Exception as error:
        # Translate native-library failures at the worker boundary; never expose their text.
        raise InferenceUnavailable() from error
