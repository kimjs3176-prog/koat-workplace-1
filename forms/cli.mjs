// 로컬·내부 서버용: Flask 가 표준입력으로 {action, body} JSON 을 주면 표준출력으로 {ok, data(base64), report|error, status} JSON 을 돌려준다.
import { run } from "./kordoc_forms.mjs"
let s = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => { s += d })
process.stdin.on("end", async () => {
  try {
    const { action, body } = JSON.parse(s || "{}")
    const r = await run(action, body)
    process.stdout.write(JSON.stringify({ ok: true, data: r.buffer ? r.buffer.toString("base64") : null, report: r.report || {} }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, status: e.status || 500, error: e.status ? e.message : "서식을 만들지 못했습니다." }))
    if (!e.status) console.error(e)
  }
})
