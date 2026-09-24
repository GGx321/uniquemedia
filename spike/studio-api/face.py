#!/usr/bin/env python3
"""Face presence, head size and identity similarity for the Studio API spike.

For every image under out/render/** and out/avatar/* (or the --image paths):
number of faces (YuNet), largest face box height / image height, and SFace
cosine similarity of the largest face to the master's face and to
pack-front's face. Writes out/face.json keyed by the path relative to out/.

SFace cosine >= 0.363 is OpenCV's same-person threshold.
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
MODELS_DIR = OUT / "models"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
# name -> (file, url, minimum plausible size in bytes; a Git LFS pointer is ~130 bytes)
MODELS = {
    "yunet": (
        "face_detection_yunet_2023mar.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        100_000,
    ),
    "sface": (
        "face_recognition_sface_2021dec.onnx",
        "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        10_000_000,
    ),
}
# 0.7 rather than the 0.9 sample default, so three-quarter faces are not dropped.
SCORE_THRESHOLD = 0.7
NMS_THRESHOLD = 0.3


def ensure_model(name: str) -> Path:
    """Download the model once; reject LFS pointer text or truncated files."""
    filename, url, min_size = MODELS[name]
    path = MODELS_DIR / filename
    if not path.exists():
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        print(f"downloading {filename} ...", file=sys.stderr)
        fd, tmp = tempfile.mkstemp(dir=MODELS_DIR, suffix=".tmp")
        with os.fdopen(fd, "wb") as f, urllib.request.urlopen(url, timeout=120) as resp:
            f.write(resp.read())
        os.replace(tmp, path)
    size = path.stat().st_size
    with path.open("rb") as f:
        head = f.read(64)
    if size < min_size or head.startswith(b"version https://git-lfs"):
        path.unlink()
        sys.exit(f"{filename}: not a real ONNX model ({size} bytes, starts {head[:24]!r}); deleted, rerun to retry")
    return path


def load_models():
    yunet = ensure_model("yunet")
    sface = ensure_model("sface")
    try:
        detector = cv2.FaceDetectorYN.create(str(yunet), "", (320, 320), SCORE_THRESHOLD, NMS_THRESHOLD, 5000)
        recognizer = cv2.FaceRecognizerSF.create(str(sface), "")
    except cv2.error as e:
        sys.exit(f"OpenCV could not load the models: {e}")
    return detector, recognizer


def largest_face(detector, img):
    """Returns (face count, largest face row or None)."""
    h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    if faces is None or len(faces) == 0:
        return 0, None
    largest = max(faces, key=lambda f: f[2] * f[3])
    return len(faces), largest


def analyse(detector, recognizer, path: Path):
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        return {"faces": 0, "headRatio": None, "width": None, "height": None, "error": "unreadable image"}, None
    h, w = img.shape[:2]
    count, face = largest_face(detector, img)
    if face is None:
        return {"faces": 0, "headRatio": None, "width": w, "height": h}, None
    feature = recognizer.feature(recognizer.alignCrop(img, face))
    return {"faces": count, "headRatio": round(float(face[3]) / h, 4), "width": w, "height": h}, feature


def find_avatar(name: str):
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = OUT / "avatar" / f"{name}{ext}"
        if p.exists():
            return p
    return None


def key_for(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(OUT))
    except ValueError:
        return str(path)


def default_targets():
    files = []
    for root in (OUT / "render", OUT / "avatar"):
        if root.exists():
            files += sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."))
    return files


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--image", action="append", default=[], help="analyse only these images (repeatable); results are merged into --output")
    ap.add_argument("--output", default=str(OUT / "face.json"), help="output JSON (default: out/face.json)")
    args = ap.parse_args()

    detector, recognizer = load_models()

    refs = {}
    for label, name in (("cosMaster", "master"), ("cosFront", "pack-front")):
        p = find_avatar(name)
        feature = analyse(detector, recognizer, p)[1] if p else None
        refs[label] = feature
        print(f"reference {name}: {'face found' if feature is not None else 'missing or no face'}", file=sys.stderr)

    targets = [Path(p) for p in args.image] if args.image else default_targets()
    output = Path(args.output)
    results = {}
    if args.image and output.exists():
        results = json.loads(output.read_text())

    for path in targets:
        entry, feature = analyse(detector, recognizer, path)
        for label, ref in refs.items():
            entry[label] = (
                round(float(recognizer.match(feature, ref, cv2.FaceRecognizerSF_FR_COSINE)), 4)
                if feature is not None and ref is not None
                else None
            )
        key = key_for(path)
        results[key] = entry
        print(f"{key}: faces={entry['faces']} head={entry['headRatio']} cosMaster={entry['cosMaster']} cosFront={entry['cosFront']}")

    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=output.parent, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(results, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, output)
    print(f"wrote {output} ({len(results)} entries)", file=sys.stderr)


if __name__ == "__main__":
    main()
