// Vercel Node 함수: /api/secretary/forms/<action> — 한글 서식 작성(kordoc)
import { run } from "../forms/kordoc_forms.mjs"

export const config = { api: { bodyParser: { sizeLimit: "8mb" } } }

export default async function handler(req, res) {
  const action = String((req.query && req.query.action) || "").replace(/[^a-z-]/g, "")
  if (action !== "status" && req.method !== "POST") { res.status(405).json({ success: false, error: "POST 로 요청하세요." }); return }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {})
    const r = await run(action, body)
    if (!r.buffer) { res.status(200).json({ success: true, ...r.report }); return }
    const name = String(body.filename || "서식").replace(/[\\/:*?"<>|\r\n]/g, "").slice(0, 80) || "서식"
    res.setHeader("Content-Type", "application/hwp+zip")
    res.setHeader("Content-Disposition", `attachment; filename="form.hwpx"; filename*=UTF-8''${encodeURIComponent(name)}.hwpx`)
    res.setHeader("X-Form-Report", encodeURIComponent(JSON.stringify(r.report || {})))
    res.setHeader("Access-Control-Expose-Headers", "X-Form-Report, Content-Disposition")
    res.status(200).send(r.buffer)
  } catch (e) {
    if (!e.status) console.error(e)
    res.status(e.status || 500).json({ success: false, error: e.status ? e.message : "서식을 만들지 못했습니다." })
  }
}
