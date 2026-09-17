#!/usr/bin/env python3
import json
import sys
from datetime import timezone

from instagrapi import Client
from instagrapi.exceptions import (
    BadCredentials,
    BadPassword,
    CaptchaChallengeRequired,
    ChallengeError,
    ClientLoginRequired,
    FeedbackRequired,
    LoginRequired,
    PleaseWaitFewMinutes,
    TwoFactorRequired,
)


def respond(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False, default=str))
    sys.stdout.flush()


def failure(kind: str, message: str) -> None:
    respond({"ok": False, "kind": kind, "message": message})


def client_for(data: dict) -> Client:
    client = Client()
    session = data.get("session")
    if isinstance(session, dict) and session:
        client.set_settings(session)
    client.login(data["username"], data["password"])
    return client


def media_payload(media) -> dict | None:
    media_type = int(media.media_type)
    if media_type in (1, 8):
        normalized_type = "photo"
    elif media_type == 2:
        normalized_type = "video"
    else:
        return None
    taken_at = media.taken_at
    if taken_at.tzinfo is None:
        taken_at = taken_at.replace(tzinfo=timezone.utc)
    surface = "reel" if getattr(media, "product_type", "") == "clips" else "p"
    return {
        "id": str(media.id),
        "code": str(media.code),
        "url": f"https://www.instagram.com/{surface}/{media.code}/",
        "mediaType": normalized_type,
        "takenAt": taken_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def main() -> int:
    try:
        data = json.load(sys.stdin)
        operation = data.get("operation")
        if operation not in ("check", "discover", "comment"):
            failure("rejected", "Неизвестная операция Instagram")
            return 0
        client = client_for(data)
        result = {"ok": True, "session": client.get_settings()}
        if operation == "check":
            client.account_info()
        elif operation == "discover":
            user_id = client.user_id_from_username(data["targetUsername"])
            result["media"] = [
                payload
                for media in client.user_medias_v1(user_id, amount=12)
                if (payload := media_payload(media)) is not None
            ]
        else:
            comment = client.media_comment(data["mediaId"], data["text"])
            result["remoteId"] = str(comment.pk)
        respond(result)
        return 0
    except (BadCredentials, BadPassword):
        failure("auth", "Instagram отклонил логин или пароль")
    except TwoFactorRequired:
        failure("challenge", "Instagram запросил двухфакторный код; требуется ручной вход")
    except (CaptchaChallengeRequired, ChallengeError):
        failure("challenge", "Instagram запросил ручное подтверждение аккаунта")
    except (FeedbackRequired, PleaseWaitFewMinutes):
        failure("rejected", "Instagram временно ограничил действия аккаунта")
    except (ClientLoginRequired, LoginRequired):
        failure("auth", "Сессия Instagram истекла; требуется повторный вход")
    except Exception:
        failure("unknown", "Результат запроса Instagram неизвестен")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
