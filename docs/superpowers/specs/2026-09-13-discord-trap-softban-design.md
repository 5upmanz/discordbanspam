# Discord Trap Channel Softban — Design

## สถานะ

ผู้ใช้อนุมัติแนวทาง: Softban, ไม่ยกเว้นทีมงาน, เก็บงานใน SQLite เพื่อกู้คืนหลังโปรเซสล่ม
ผู้ใช้ตรวจและอนุมัติเอกสารนี้แล้วในแชทด้วยข้อความ “ok ตามนี้”
Implementation plan: `docs/superpowers/plans/2026-09-13-discord-trap-softban.md`
Repository เริ่มต้นว่าง ไม่มี Git repository หรือโค้ดเดิม ณ วันที่ตรวจ 2026-09-13

## 1. เป้าหมาย

ใช้ Discord bot เฝ้า text channel หนึ่งห้องใน guild หนึ่งแห่ง เมื่อสมาชิกส่งข้อความ ให้แบนพร้อมร้องขอลบข้อความย้อนหลัง 7 วันทั่ว guild แล้วปลดแบนทันทีเมื่อแบนสำเร็จ สมาชิกออกจาก guild และสามารถกลับด้วย invite ได้เอง บอทไม่เชิญกลับ

“ทันที” หมายถึงเริ่มจัดการเมื่อได้รับ event ไม่หน่วงเวลาโดยเจตนา ไม่ใช่คำรับประกัน latency ของ Discord API
“ลบประวัติ” หมายถึง Discord ban deletion window สูงสุด 604800 วินาที ไม่รวมข้อความเก่ากว่า 7 วัน, DM หรือ guild อื่น และไม่รับประกันเวลาที่ Discord จะลบเสร็จ

## 2. ขอบเขตและกฎ

- จับ Gateway messageCreate โดยจับคู่ guildId และ channelId แบบ exact ID เท่านั้น
- ข้อความทุกชนิดเข้าเงื่อนไข: text, attachment, sticker, embed-only ไม่อ่านเนื้อหาเพื่อจำแนก spam
- ไม่ย้อนหลังสแกนข้อความที่ส่งระหว่างบอท offline; Gateway resume อาจส่งบาง event ซ้ำได้ จึงต้องกันงานซ้ำ
- ไม่รวม thread ใต้ห้องดัก เพราะ channelId ต่างกัน
- ไม่มี allowlist สมาชิก, role หรือทีมงาน สมาชิกบอทอื่นเข้าเงื่อนไขเช่นกันถ้าเป็นข้อความของสมาชิกจริง
- ข้ามข้อความของบอทตัวเอง, webhook และ system message ที่ไม่ได้เป็นข้อความส่งโดยสมาชิก
- owner และสมาชิกที่ role สูงเท่ากับ/สูงกว่าบอทแบนไม่ได้ ต้องบันทึก failure ไม่อ้างว่า softban สำเร็จ
- ไม่ยกระดับสิทธิ์ ไม่แก้ role และไม่ fallback เป็น kick
- ไม่สร้างข้อความเตือน, embed, ปุ่มหรือตัวนับตามภาพอัตโนมัติในรุ่นแรก ภาพใช้เป็นตัวอย่างพฤติกรรมเท่านั้น
- บัญชีหนึ่งมี active job ได้ไม่เกินหนึ่งงานต่อ guild; event ซ้ำของ messageId เดิมต้องไม่สร้างงานใหม่
- หลังงานเดิมจบ ถ้าสมาชิกกลับมาและส่งข้อความใหม่ ต้อง softban ได้อีก

## 3. เทคโนโลยีและการติดตั้ง

- Node.js 24 LTS, TypeScript strict, discord.js 14, better-sqlite3, Vitest
- npm พร้อม package-lock.json; agent เลือกและล็อก patch version ที่รองรับ Node.js 24 ตอน implementation
- หนึ่งโปรเซสต่อ bot/guild configuration เท่านั้น ไม่รองรับหลาย replica หรือ SQLite บน network share
- SQLite อยู่บน persistent local disk, เปิด WAL; การเขียนสถานะสำคัญต้อง commit ก่อนยิง API
- Config: DISCORD_TOKEN, GUILD_ID, TRAP_CHANNEL_ID, DATABASE_PATH, LOG_LEVEL
- validate ค่าเมื่อเริ่มระบบ; token ห้ามเขียนลง log หรือ commit; มี .env.example และ .gitignore
- Discord intents: Guilds และ GuildMessages; ไม่ต้องเปิด MessageContent เพราะไม่ใช้เนื้อหา
- สิทธิ์: ViewChannel ในห้องดัก และ BanMembers ใน guild; วาง role บอทเหนือ role เป้าหมาย
- ใช้ official bot token เท่านั้น ไม่ใช้ user token หรือ self-bot
- Deployment documentation ครอบคลุม persistent storage, restart policy และการตรวจ error บน Windows; ไม่ตั้งบริการระบบจริงให้ผู้ใช้ระหว่าง implementation

## 4. โครงสร้าง

- src/config.ts: parse/validate environment
- src/db.ts: เปิด SQLite, migration และปิดฐานข้อมูล
- src/jobs.ts: durable job repository, state transitions, deduplication
- src/discord-adapter.ts: ห่อ Discord API, normalize error และอ่าน ban reason เพื่อยืนยัน ownership โดยไม่พึ่ง audit log
- src/trap-handler.ts: filter event, สร้าง durable job และปลุก worker
- src/softban-worker.ts: ban/unban state machine, recovery และ retry
- src/logger.ts: structured JSON logs พร้อม redaction
- src/index.ts: startup, client lifecycle, worker scheduling และ shutdown
- tests/: unit/integration tests; ใช้ fake Discord adapter และ SQLite ชั่วคราว ไม่ยิง API จริง
- README.md, .env.example, package.json, tsconfig.json, vitest.config.ts

ขอบเขต interface และ schema SQL แบบละเอียดจะล็อกใน implementation plan

## 5. Durable workflow

เก็บ jobId, guildId, userId, triggerMessageId, state, banReason, timestamps, attempts, nextAttemptAt, lastError และผลการยืนยัน ownership ของ ban
banReason เป็น marker เฉพาะงาน เช่น trap-softban:<jobId>; ไม่ใส่ message content หรือ token

สถานะ: queued → banning → unbanning → completed
ทางแยก: failed (ทำต่ออัตโนมัติไม่ได้), manual_review (ผลหรือเจ้าของ ban ไม่ชัดเจน)
Retry เก็บสถานะเดิมและ nextAttemptAt; ไม่ตั้ง completed จนยืนยันว่าปลดแบนแล้วหรือไม่มี ban เหลืออยู่

1. บันทึก queued แบบ transaction ก่อนตอบรับ event ว่ารับงานแล้ว
2. ตรวจ ban ปัจจุบันก่อนเริ่มงานใหม่ หากมี ban อยู่ก่อน ต้องไม่ยึดเป็นของงานนี้ และห้ามปลดแบนของผู้ดูแล
3. commit banning พร้อม marker ก่อนเรียก ban(userId, deleteMessageSeconds=604800, reason=marker)
4. เมื่อ ban สำเร็จ commit unbanning แล้วร้องขอ unban ทันที โดยไม่ตั้งเวลารอ
5. ก่อน unban ตรวจว่ารายการ ban ปัจจุบันมี reason ตรง marker งานนี้ หากเป็น ban อื่นหรือยืนยันไม่ได้ ส่ง manual_review และแจ้ง log ระดับ error
6. unban สำเร็จจึง commit completed; ถ้า Discord ยืนยัน Unknown Ban ให้นับว่าการปลดแบนจบแล้ว

### Recovery และความปลอดภัยของการปลดแบน

- เริ่มระบบต้องโหลด active jobs ก่อนเริ่มรับงานใหม่ และให้ความสำคัญกับงาน unbanning ก่อนงาน ban ใหม่
- queued: เริ่ม workflow ตามปกติ
- banning หลัง crash/timeout: fetch ban เพื่อ reconcile ถ้า marker ตรง ให้ไป unbanning; ถ้า ban ของผู้อื่น ให้ manual_review
- ถ้า banning หลังผล API ไม่แน่นอนและไม่พบ ban ห้าม re-ban อัตโนมัติ เพราะอาจเกิด ban/unban สำเร็จไปแล้วหรือผู้ดูแลแทรกแซง ให้ manual_review
- unbanning: ถ้าไม่พบ ban ให้ completed; ถ้า marker ตรงให้ retry unban; ถ้าไม่ตรงให้ manual_review
- ใช้ ban reason จาก ban record เพื่อยืนยัน ownership; ไม่บังคับ ViewAuditLog และไม่พึ่ง audit log ที่อาจล่าช้า หาก reason อ่านไม่ได้ต้องไม่เดา
- Discord ไม่มี atomic compare-and-unban จึงป้องกัน race กับผู้ดูแลได้ไม่สมบูรณ์ แม้ตรวจ marker ก่อนลบ ต้องระบุข้อจำกัดนี้ใน README และแนะนำไม่ทำ manual ban/unban เป้าหมายเดียวกันระหว่าง active job
- ห้ามใช้ recovery แบบ “ปลดแบนทุกคนที่มีงานค้าง” โดยไม่มี ownership check

## 6. Error handling และ operation

- discord.js จัดการ REST rate limits ตามไลบรารี ห้ามสร้าง tight retry loop หรือ retry ซ้อนเมื่อ request ยัง pending
- Retry สำหรับ fetch/unban ที่ timeout, network error หรือ 5xx: exponential backoff เริ่ม 1 วินาที สูงสุด 60 วินาที พร้อม jitter; เก็บ due time ลง SQLite
- Ban ที่ผลไม่แน่นอนต้อง reconcile ก่อน ห้ามยิง ban ซ้ำแบบ blind retry
- Permission error, hierarchy error, invalid configuration ไม่ retry ถี่; failed หากยังไม่ ban และ manual_review หากอาจมี ban ค้าง
- unban transient failure ต้องเก็บงานไว้ retry ต่อ ไม่ discard หลังจำนวนครั้งตายตัว; แจ้ง error เมื่อยังไม่จบเกิน 60 วินาทีและแจ้งซ้ำไม่เกินหนึ่งครั้งต่อ 5 นาที
- SQLite เขียนไม่ได้: หยุดรับงานใหม่และไม่ยิง ban ใหม่ที่ยังไม่มี durable record; หาก ban สำเร็จแล้วแต่ persist ล้ม ให้พยายามตรวจ ownership และ unban ทันที พร้อม critical log แล้วหยุดเพื่อให้ supervisor restart/recovery
- structured logs: event, jobId, guildId, channelId, userId, state, errorCode, retryAt เท่าที่เกี่ยวข้อง ไม่เก็บเนื้อหา/ไฟล์แนบของสมาชิก
- log เป็นช่องแจ้งเตือนในรุ่นแรก ผู้ดูแลต้องจัดการการเก็บ/ส่งต่อ log ภายนอก ไม่ส่ง log เข้าห้องดัก
- readiness ต้องตรวจ guild/channel ว่าตรงและเป็น GuildText และตรวจสิทธิ์ก่อนเริ่มรับงาน; ถ้า config/scope ไม่ผ่านให้ปิดรับงานพร้อม error ชัดเจน
- connection หลุด: บันทึกสถานะและใช้ reconnect ของ client; ไม่อ้างว่าเฝ้าอยู่ระหว่าง offline
- shutdown: หยุดรับงานใหม่ หยุด scheduler รอ active calls แบบมี timeout แล้วปิด client/database; durable states ต้องกู้คืนได้หากถูก kill

## 7. การทดสอบและ acceptance criteria

ใช้ mocks สำหรับ API, fake clock สำหรับ retry และ SQLite จริงแบบ temporary file สำหรับ durability

1. ข้อความจากคนใน guild/channel ที่ตรงสร้างงานและเรียก ban ก่อน unban ด้วย deleteMessageSeconds=604800
2. text/attachment/sticker และสมาชิกทีมงานไม่ถูกยกเว้น; สมาชิกบอทอื่นไม่ถูก skip เพียงเพราะ author.bot
3. ห้องอื่น, guild อื่น, DM, thread, webhook, self และ system event ไม่สร้างงาน
4. ข้อความพร้อมกันของคนเดียวกันสร้าง active job เดียว; duplicate messageId ไม่ทำงานซ้ำ
5. สมาชิกกลับมาโพสต์ messageId ใหม่หลัง completed สร้าง job ใหม่ได้
6. pre-existing ban ไม่ถูกปลดแบน
7. owner/hierarchy/permission failure ไม่เรียก unban และ log เหตุผลตรง
8. ban สำเร็จแล้ว unban network failure: ไม่อ้าง completed และ retry จนสำเร็จ
9. restart หลัง ban สำเร็จก่อน persist: marker ตรงทำให้ปลดแบนต่อได้
10. restart หลัง unban สำเร็จก่อน persist: Unknown Ban ทำให้ completed โดยไม่ re-ban
11. ambiguous banning + ไม่พบ ban, marker ไม่ตรงหรืออ่านไม่ได้: manual_review ไม่ re-ban/unban แบบเดา
12. test crash boundaries ก่อน/หลัง durable transitions ทุกจุด และเปิด SQLite ไฟล์เดิมเพื่อยืนยัน recovery
13. ตรวจ backoff, log throttling, queue priority, shutdown และ database failure
14. npm test, npm run typecheck และ npm run build ผ่าน; tests ไม่ต้องมี token
15. ทดลองเฉพาะ guild ทดสอบ: สมาชิกทดสอบส่งข้อความห้องอื่นก่อน แล้วส่งห้องดัก ตรวจว่าออกจาก guild, ไม่เหลือ ban, ข้อความใน 7 วันถูก Discord ลบ และกลับด้วย invite ได้
16. ห้ามทดสอบ destructive behavior ใน production guild โดยไม่ได้รับอนุญาตชัดเจน

## 8. ขั้นถัดไปและ checklist

- [x] ตรวจโฟลเดอร์และภาพอ้างอิง
- [x] ยืนยัน softban แทน permanent ban
- [x] ยืนยันไม่ยกเว้นทีมงาน
- [x] เสนอทางเลือกและรับอนุมัติ durable design
- [x] เขียนและ self-review spec
- [x] ผู้ใช้ตรวจ spec
- [x] เขียน implementation plan แบบ task-by-task พร้อม interfaces, test code, commands และ handoff instructions

ยังไม่สร้าง Git commit เพราะโฟลเดอร์นี้ไม่มี Git repository และยังไม่ได้ตั้ง repository ให้ผู้ใช้
