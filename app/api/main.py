from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from supabase import create_client
import os, asyncio, json

load_dotenv()
SUPA = create_client(os.environ["SUPABASE_URL"],
                     os.environ["SUPABASE_ANON_KEY"])

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

@app.websocket("/ws")
async def ws_alerts(ws: WebSocket):
    await ws.accept()
    last = 0
    while True:
        rows = (SUPA.table("iuu_alerts")
                   .select("*")
                   .gt("id", last)
                   .order("id")
                   .limit(100)
                   .execute()).data
        for r in rows:
            await ws.send_text(json.dumps(r))
            last = r["id"]
        await asyncio.sleep(5)
