import asyncio
import os
import time
import threading
from typing import Optional
from queue import Queue

import cv2
import numpy as np
from dotenv import load_dotenv
from ultralytics import YOLO
import websockets


load_dotenv()

RTSP_URL = os.getenv("RTSP_URL")
NGROK_URL = os.getenv("NGROK_PUBLIC_URL")

AI_IMG_SIZE = int(os.getenv("AI_IMG_SIZE", "320"))
AI_CONF_MIN = float(os.getenv("AI_CONF_MIN", "0.35"))
AI_IOU_NMS  = float(os.getenv("AI_IOU_NMS",  "0.45"))
AI_TARGET_FPS = int(os.getenv("AI_TARGET_FPS", "30"))
AI_FRAME_SKIP = int(os.getenv("AI_FRAME_SKIP", "1"))
AI_RESIZE_W   = int(os.getenv("AI_RESIZE_W",   "480"))

_raw_classes = os.getenv("AI_CLASSES", "all").strip().lower()
if _raw_classes in ("", "all"):
    AI_CLASSES = None
else:
    try:
        AI_CLASSES = [int(x) for x in _raw_classes.split(",") if x.strip() != ""]
    except Exception:
        AI_CLASSES = None

AI_CENTER_DEADBAND = float(os.getenv("AI_CENTER_DEADBAND", "0.15"))
AI_MID_AREA        = float(os.getenv("AI_MID_AREA",        "0.10"))
AI_NEAR_AREA       = float(os.getenv("AI_NEAR_AREA",       "0.18"))
AI_NEAR_HEIGHT_N   = float(os.getenv("AI_NEAR_HEIGHT_N",   "0.40"))
AI_BOTTOM_NEAR     = float(os.getenv("AI_BOTTOM_NEAR",     "0.82"))
AI_TARGET_DIST_CM  = int(os.getenv("AI_TARGET_DIST_CM", "30"))

AI_TURN_DEG            = int(os.getenv("AI_TURN_DEG", "25"))
AI_TURN_MS_PER_DEG     = int(os.getenv("AI_TURN_MS_PER_DEG", "12"))
AI_AVOID_TURN_EXTRA_MS = int(os.getenv("AI_AVOID_TURN_EXTRA_MS", "0"))

AI_STOP_MS           = int(os.getenv("AI_STOP_MS", "50"))
AI_BACK_MS           = int(os.getenv("AI_BACK_MS", "160"))
AI_FORWARD_AFTER_AVOID_MS = int(os.getenv("AI_FORWARD_AFTER_AVOID_MS", "5000"))
AI_RECOVER_FWD_MS    = int(os.getenv("AI_RECOVER_FWD_MS", "140"))
AI_STEER_COOLDOWN_MS = int(os.getenv("AI_STEER_COOLDOWN_MS", "120"))
AI_POST_AVOID_COOLDOWN_MS = int(os.getenv("AI_POST_AVOID_COOLDOWN_MS", "200"))

AI_CLEAR_BRAKE_MS = int(os.getenv("AI_CLEAR_BRAKE_MS", "120"))
AI_CLEAR_HOLD_MS  = int(os.getenv("AI_CLEAR_HOLD_MS", "160"))

AI_NO_OBJECT = os.getenv("AI_NO_OBJECT", "S").strip().upper()
AI_DEBUG_VISION = int(os.getenv("AI_DEBUG_VISION", "0")) == 1

WS_URI = f"wss://{NGROK_URL}/auto-control"


def now_ms() -> int:
    return int(time.time() * 1000)


frame_queue: "Queue[np.ndarray]" = Queue(maxsize=3)

def get_latest_frame() -> Optional[np.ndarray]:
    if frame_queue.empty():
        return None
    last = None
    while not frame_queue.empty():
        try:
            last = frame_queue.get_nowait()
        except Exception:
            break
    return last

class CameraReader:
    def __init__(self, url: str):
        self.url = url
        self.cap = None
        self.running = False

    def start(self):
        self.cap = cv2.VideoCapture(self.url)
        if not self.cap.isOpened():
            raise RuntimeError(f"No se pudo abrir RTSP: {self.url}")
        try:
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        self.running = True

        def loop():
            while self.running:
                ok, frame = self.cap.read()
                if not ok:
                    time.sleep(0.004)
                    continue
                h = int(frame.shape[0] * (AI_RESIZE_W / frame.shape[1]))
                frame = cv2.resize(frame, (AI_RESIZE_W, h))
                if frame_queue.full():
                    try:
                        frame_queue.get_nowait()
                    except Exception:
                        pass
                frame_queue.put(frame)
        threading.Thread(target=loop, daemon=True).start()

    def stop(self):
        self.running = False
        try:
            if self.cap is not None:
                self.cap.release()
        except Exception:
            pass

class AutoPilot:
    def __init__(self):
        print("🚀 Cargando modelo YOLOv8n…")
        self.model = YOLO("yolov8n.pt")
        self.ws = None

        self.front_close = False
        self.cx_norm = 0.5
        self.very_close = False
        self.last_seen_ms = 0  

        self.seq_task: Optional[asyncio.Task] = None
        self.seq_token = 0
        self.busy_until_ms = 0

        self.last_cmd = "S"

    async def connect_ws(self):
        print(f"🌐 Conectando WS: {WS_URI}")
        self.ws = await websockets.connect(WS_URI, ping_interval=None)
        print("✅ WS conectado")

    async def send(self, cmd: str):
        cmd = cmd.strip().upper()
        if cmd not in ("F","B","L","R","S","V","W","X"):
            return
        if not self.ws:
            return
        if cmd == self.last_cmd and cmd != "S":
            return
        try:
            await self.ws.send(cmd)
            self.last_cmd = cmd
        except Exception as e:
            print(f"⚠️ WS send error: {e}")

    async def cooperative_sleep(self, ms: int, brake_on_clear: bool = True, brake_on_front: bool = True):
        """duerme en pasos cortos y frena si se limpia la vista (o si vuelve obstáculo, según flags)."""
        end = now_ms() + ms
        step = 15  
        while now_ms() < end:
            if brake_on_clear and (now_ms() - self.last_seen_ms > AI_CLEAR_BRAKE_MS):
                await self.send("S")
                return False
            if brake_on_front and self.front_close:
                await self.send("S")
                return False
            await asyncio.sleep(step / 1000.0)
        return True

    def choose_turn_away(self, cx_norm: float) -> str:
        """Girar alejándose del obstáculo."""
        return "R" if cx_norm < 0.5 else "L"

    def is_front_and_close(self, W: int, H: int, xyxy: np.ndarray):
        x1, y1, x2, y2 = xyxy
        w = max(1, x2 - x1)
        h = max(1, y2 - y1)
        area_frac = (w * h) / float(W * H)
        cx = (x1 + x2) / 2.0
        cx_n = cx / float(W)
        bottom_n = max(y1, y2) / float(H)
        h_n = h / float(H)

        center_left = 0.5 - AI_CENTER_DEADBAND
        center_right = 0.5 + AI_CENTER_DEADBAND
        in_center = (center_left <= cx_n <= center_right)

        near_by_height = h_n >= AI_NEAR_HEIGHT_N
        near_by_bottom = bottom_n >= AI_BOTTOM_NEAR
        near_by_area   = area_frac >= AI_NEAR_AREA

        is_front = in_center or near_by_area
        is_close = near_by_height or near_by_bottom or near_by_area
        return (is_front and is_close), cx_n, h_n, area_frac

    def pick_primary_obstacle(self, W: int, H: int, boxes):
        best = None
        best_score = -1.0
        for b in boxes:
            if float(b.conf[0]) < AI_CONF_MIN:
                continue
            xyxy = b.xyxy[0].cpu().numpy().astype(int)
            x1, y1, x2, y2 = xyxy
            area = max(1, (x2 - x1) * (y2 - y1))
            area_frac = area / float(W * H)
            bottom_n = max(y1, y2) / float(H)
            score = (area_frac * 0.7) + (bottom_n * 0.3)
            if score > best_score:
                best_score = score
                best = xyxy
        return best

    async def avoid_sequence(self, token: int, turn_dir: str, turn_ms: int):
        """Secuencia: S -> (opcional B) -> giro (por grados) -> avanzar hasta 5s (cancelable) -> S"""
        if token != self.seq_token:
            return

        await self.send("S")
        ok = await self.cooperative_sleep(AI_STOP_MS, brake_on_clear=True, brake_on_front=False)
        if token != self.seq_token:
            return

        if self.very_close:
            await self.send("B")
            ok = await self.cooperative_sleep(AI_BACK_MS, brake_on_clear=True, brake_on_front=False)
            await self.send("S")
            if token != self.seq_token or not ok:
                return

        await self.send(turn_dir)
        ok = await self.cooperative_sleep(turn_ms, brake_on_clear=True, brake_on_front=False)
        await self.send("S")
        if token != self.seq_token or not ok:
            return

        await self.send("F")
        await self.cooperative_sleep(AI_FORWARD_AFTER_AVOID_MS, brake_on_clear=True, brake_on_front=True)
        await self.send("S")

        self.busy_until_ms = now_ms() + AI_POST_AVOID_COOLDOWN_MS

    async def run(self):
        cam = CameraReader(RTSP_URL)
        cam.start()
        while True:
            try:
                await self.connect_ws()
                break
            except Exception as e:
                print(f"⚠️ WS connect error: {e}, reintentando en 1s…")
                await asyncio.sleep(1)

        frame_idx = 0
        while True:
            try:
                frame = get_latest_frame()
                if frame is None:
                    await asyncio.sleep(0.001)
                    continue

                frame_idx += 1
                if frame_idx % AI_FRAME_SKIP != 0:
                    await asyncio.sleep(0)
                    continue

                H, W = frame.shape[:2]

                results = self.model.predict(
                    frame,
                    imgsz=AI_IMG_SIZE,
                    conf=AI_CONF_MIN,
                    iou=AI_IOU_NMS,
                    classes=AI_CLASSES,
                    verbose=False,
                    half=True
                )

                self.front_close = False
                self.very_close = False
                if results and results[0].boxes is not None and len(results[0].boxes) > 0:
                    xyxy = self.pick_primary_obstacle(W, H, results[0].boxes)
                    if xyxy is not None:
                        front_close, cx_n, h_n, area_frac = self.is_front_and_close(W, H, xyxy)
                        if front_close:
                            self.front_close = True
                            self.cx_norm = cx_n
                            self.very_close = (h_n >= AI_NEAR_HEIGHT_N)
                            self.last_seen_ms = now_ms()

                            if AI_DEBUG_VISION:
                                dbg = frame.copy()
                                x1, y1, x2, y2 = [int(v) for v in xyxy]
                                cv2.rectangle(dbg, (x1, y1), (x2, y2), (0, 255, 0), 2)
                                cx_px = int(self.cx_norm * W)
                                cv2.line(dbg, (cx_px, 0), (cx_px, H), (255, 0, 0), 1)
                                cv2.imshow("AI Debug", dbg)
                                cv2.waitKey(1)

                if self.front_close:
                    if (self.seq_task is None or self.seq_task.done()) and now_ms() >= self.busy_until_ms:
                        self.seq_token += 1
                        turn_ms = AI_TURN_DEG * AI_TURN_MS_PER_DEG + AI_AVOID_TURN_EXTRA_MS
                        turn_dir = self.choose_turn_away(self.cx_norm)
                        self.seq_task = asyncio.create_task(self.avoid_sequence(self.seq_token, turn_dir, turn_ms))
                else:
                    if (now_ms() - self.last_seen_ms) > AI_CLEAR_HOLD_MS:
                        if self.last_cmd != AI_NO_OBJECT:
                            await self.send(AI_NO_OBJECT)

                await asyncio.sleep(0)

            except websockets.ConnectionClosed:
                print("🔌 WS desconectado, reintentando…")
                self.ws = None
                await asyncio.sleep(0.5)
                try:
                    await self.connect_ws()
                except Exception as e:
                    print(f"⚠️ WS reconex error: {e}")
            except Exception as e:
                print(f"⚠️ Loop error: {e}")
                await asyncio.sleep(0.004)

if __name__ == "__main__":
    print("🤖 Autopiloto: QUIETO si no hay obstáculo, evasión por grados + avance cancelable")
    ctrl = AutoPilot()
    try:
        asyncio.run(ctrl.run())
    except KeyboardInterrupt:
        print("\n🛑 Apagado solicitado")
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass
