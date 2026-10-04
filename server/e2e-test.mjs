// 端到端断言：需在独立干净数据库上启动的服务器上运行（SEED=1）。
// 用法：node server/e2e-test.mjs http://localhost:3000
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
async function call(path, opts) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const resultsByBib = async () => {
  const r = await call('/api/results');
  return new Map(r.body.results.map(x => [x.bib, x]));
};
const rev = async () => (await call('/api/event')).body.revision;

console.log('1) 种子赛事与初始排名');
{
  const ev = (await call('/api/event')).body;
  ok('赛事已配置', ev.configured);
  const seedRev = await rev();
  ok('种子完成后修订号为 1（配置与演示读数在同一初始事务落库）', seedRev === 1, `rev=${seedRev}`);
  const rs = await resultsByBib();
  ok('001 完成 910 第一', rs.get('001').status === 'ok' && rs.get('001').elapsed === 910 && rs.get('001').rank === 1);
  ok('001 最早链排除逆序 A1@820/取 A2@300', JSON.stringify(rs.get('001').chain.map(c => c.point)) === JSON.stringify(['S','A2','B1','F']));
  ok('004/006 同耗时 1000 并列第 2', rs.get('004').rank === 2 && rs.get('006').rank === 2 && rs.get('004').elapsed === 1000);
  ok('004 多余点 ZZ@99999 不入链', rs.get('004').chain.every(c => c.point !== 'ZZ'));
  ok('002 终点超时并给出秒数', rs.get('002').status === 'finish_dnf' && rs.get('002').failAt === '终点' && /1850/.test(rs.get('002').detail));
  ok('003 首个未完成组=湖畔组', rs.get('003').status === 'group_dnf' && rs.get('003').failAt === '湖畔组');
  ok('005 出发不唯一', rs.get('005').status === 'bad_start');
}

console.log('2) 整批拒绝规则');
{
  const r0 = await rev();
  const neg = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B1', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B2', bib: '050', point: 'A1', seconds: -3, kind: 'enroute' },
  ]})});
  ok('负秒数 400 整批拒绝', neg.status === 400 && /负秒数/.test(neg.body.error));
  const dupDb = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 999, kind: 'start' },
  ]})});
  ok('同记录号异内容（与库冲突）400', dupDb.status === 400 && /R0001/.test(dupDb.body.error));
  const dupBatch = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B9', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B9', bib: '050', point: 'F', seconds: 5, kind: 'finish' },
  ]})});
  ok('批次内同记录号异内容 400', dupBatch.status === 400 && /B9/.test(dupBatch.body.error));
  const after = await call('/api/punches?bib=050');
  ok('整批回滚：050 无任何打卡', after.body.punches.length === 0);
}

console.log('3) 修订号乐观锁');
{
  const r0 = await rev();
  const stale = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 + 999, punches: [
    { recordNo: 'S1', bib: '060', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('过期修订 409 且返回当前修订', stale.status === 409 && stale.body.currentRevision === r0);
  const missing = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ punches: [] })});
  ok('缺 expectedRevision 400', missing.status === 400);
}

console.log('4) 合法导入与幂等');
{
  const r0 = await rev();
  const imp = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E1', bib: '008', name: '测试选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E2', bib: '008', point: 'A2', seconds: 150, kind: 'enroute' },
    { recordNo: 'E3', bib: '008', point: 'B1', seconds: 600, kind: 'enroute' },
    { recordNo: 'E4', bib: '008', point: 'F', seconds: 777, kind: 'finish' },
  ]})});
  ok('导入成功，4 新增 1 跳过', imp.status === 200 && imp.body.inserted === 4 && imp.body.skipped === 1);
  ok('导入后修订号 +1', imp.body.revision === r0 + 1);
  const rs = await resultsByBib();
  ok('008 完成 777（B1 恰在组截止 600 有效；终点 777<=1800）', rs.get('008').elapsed === 777 && rs.get('008').rank === 1);
}

console.log('5) 作废/更正留痕并重算');
{
  // 005 两条出发：R0040 id=20, R0041 id=21
  const noReason = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({}) });
  ok('作废无原因 400', noReason.status === 400);
  const v = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({ reason: '设备重复上报' }) });
  ok('作废成功并推进修订', v.status === 200);
  const rs1 = await resultsByBib();
  ok('作废重复出发后 005 以 980 完成', rs1.get('005').status === 'ok' && rs1.get('005').elapsed === 980);
  const neg = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: 'x', newPoint: 'A1', newSeconds: -1 }) });
  ok('更正为负秒数 400', neg.status === 400);
  const c = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: '现场记录更正', newPoint: 'B2', newSeconds: 700 }) });
  ok('更正成功', c.status === 200);
  const rs2 = await resultsByBib();
  // 004 原有 A1@400, B2@720；把 ZZ 改为 B2@700 后，组2取更早的 B2@700，终点仍 F@1000
  const chain4 = rs2.get('004').chain.map(x => `${x.point}@${x.seconds}`);
  ok('004 链采用更正后的更早 B2@700', chain4.includes('B2@700') && !chain4.includes('B2@720'), chain4.join(' '));
  const audits = (await call('/api/punches?bib=004')).body.audits;
  const a = audits.find(x => x.action === 'correct');
  ok('审计保留原值 ZZ@99999', a && a.origPoint === 'ZZ' && a.origSeconds === 99999 && a.newPoint === 'B2' && a.reason === '现场记录更正');
}

console.log('6) 更正/作废后的重导语义（按首次入库原始读数判定）');
{
  const r0 = await rev();
  // id 17 = R0032：现值 B2@700，首次入库读数 ZZ@99999（第 5 节已更正）
  const reOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0032', bib: '004', point: 'ZZ', seconds: 99999, kind: 'enroute' },
  ]})});
  ok('按首读重导更正记录：200 幂等跳过', reOrig.status === 200 && reOrig.body.inserted === 0 && reOrig.body.skipped === 1, JSON.stringify(reOrig.body));
  const p17a = (await call('/api/punches?bib=004')).body.punches.find(x => x.record_no === 'R0032');
  ok('重导不覆盖更正现值且首读保留', p17a.point === 'B2' && p17a.seconds === 700 && p17a.origPoint === 'ZZ' && p17a.origSeconds === 99999);
  const audits4a = (await call('/api/punches?bib=004')).body.audits;
  ok('重导不新增审计', audits4a.filter(a => a.punchId === 17).length === 1);

  const r1 = await rev();
  const reCurrent = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, punches: [
    { recordNo: 'R0032', bib: '004', point: 'B2', seconds: 700, kind: 'enroute' },
  ]})});
  ok('提交值等于更正现值但异于首读：整批拒绝', reCurrent.status === 400 && /R0032/.test(reCurrent.body.error), JSON.stringify(reCurrent.body));

  const r2 = await rev();
  const mixed = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, punches: [
    { recordNo: 'R0700', bib: '010', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'R0032', bib: '004', point: 'B2', seconds: 700, kind: 'enroute' },
  ]})});
  ok('冲突混新记录整批拒绝', mixed.status === 400);
  const afterMixed = await call('/api/punches?bib=010');
  ok('不部分入库：010 无任何打卡', afterMixed.body.punches.length === 0);
  ok('整批拒绝不推进修订', (await rev()) === r2);

  const r3 = await rev();
  const reVoided = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r3, punches: [
    { recordNo: 'R0041', bib: '005', point: 'S', seconds: 5, kind: 'start' },
  ]})});
  ok('作废记录按首读重导：跳过且不复活', reVoided.status === 200 && reVoided.body.inserted === 0 && reVoided.body.skipped === 1, JSON.stringify(reVoided.body));
  const p21 = (await call('/api/punches?bib=005')).body.punches.find(x => x.record_no === 'R0041');
  ok('作废状态与原因保留', p21.status === 'voided' && p21.void_reason === '设备重复上报');

  // 多次更正后仍按最初读数判断
  const c2 = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: '二次申诉更正', newPoint: 'B1', newSeconds: 650 }) });
  ok('二次更正成功', c2.status === 200);
  const r4 = await rev();
  const reOrig2 = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r4, punches: [
    { recordNo: 'R0032', bib: '004', point: 'ZZ', seconds: 99999, kind: 'enroute' },
  ]})});
  ok('二次更正后按最初读数重导仍跳过', reOrig2.status === 200 && reOrig2.body.inserted === 0);
  const p17b = (await call('/api/punches?bib=004')).body.punches.find(x => x.record_no === 'R0032');
  ok('二次更正现值保留、首读仍是 ZZ@99999', p17b.point === 'B1' && p17b.seconds === 650 && p17b.origPoint === 'ZZ' && p17b.origSeconds === 99999);
  const audits4b = (await call('/api/punches?bib=004')).body.audits;
  ok('两次更正各留一条审计', audits4b.filter(a => a.punchId === 17 && a.action === 'correct').length === 2);
  const rsNow = await resultsByBib();
  ok('实时成绩沿用裁判现值（004 链取 B1@650）', JSON.stringify(rsNow.get('004').chain.map(c => `${c.point}@${c.seconds}`)).includes('B1@650'));

  // 同批：首读重复记录 + 全新记录混合 => 重复跳过、新记录正常入库
  const r5 = await rev();
  const mix2 = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r5, punches: [
    { recordNo: 'R0032', bib: '004', point: 'ZZ', seconds: 99999, kind: 'enroute' },
    { recordNo: 'R0801', bib: '009', name: '重导混入', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'R0802', bib: '009', point: 'A2', seconds: 300, kind: 'enroute' },
    { recordNo: 'R0803', bib: '009', point: 'B1', seconds: 600, kind: 'enroute' },
    { recordNo: 'R0804', bib: '009', point: 'F', seconds: 800, kind: 'finish' },
  ]})});
  ok('首读重复与新记录同批：新增 4 跳过 1', mix2.status === 200 && mix2.body.inserted === 4 && mix2.body.skipped === 1, JSON.stringify(mix2.body));
  const rs9 = await resultsByBib();
  ok('009 按新记录完成 800', rs9.get('009').status === 'ok' && rs9.get('009').elapsed === 800);
}

console.log('7) 发布冻结与历史版不可变');
{
  const before = await resultsByBib();
  const v005 = before.get('005').elapsed;
  const r0 = await rev();
  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, note: '冻结首版' }) });
  ok('发布 v1 成功', pub.status === 200 && pub.body.version === 1);
  const stalePub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 }) });
  ok('发布后旧修订再发布 409', stalePub.status === 409);
  const snap = (await call('/api/publications/1')).body;
  ok('v1 快照 005 成绩=' + v005, snap.results.find(x => x.bib === '005').elapsed === v005);
  ok('v1 快照不含作废读数（005 仅 4 条）', snap.readings.filter(x => x.bib === '005').length === 4);

  // 发布之后：更正 001 的 A2@300 -> A1@250，再发布 v2
  const p1 = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  const r1 = await rev();
  const cor = await call(`/api/punches/${p1.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '发布后申诉更正', newPoint: 'A1', newSeconds: 250 }) });
  ok('发布后更正成功', cor.status === 200);
  const r2 = await rev();
  const pub2 = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, note: '第二版' }) });
  ok('发布 v2', pub2.status === 200 && pub2.body.version === 2);
  const snap1 = (await call('/api/publications/1')).body;
  const snap2 = (await call('/api/publications/2')).body;
  ok('v1 历史版读数仍是旧 A2@300', snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' && snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);
  ok('v2 读数为更正后 A1@250', snap2.readings.find(x => x.record_no === 'R0003').point === 'A1' && snap2.readings.find(x => x.record_no === 'R0003').seconds === 250);
  ok('v1/v2 配置均已冻结', snap1.config.groups.length === 2 && snap2.config.groups.length === 2);
  const list = (await call('/api/publications')).body.publications;
  ok('版本列表按版本倒序', list[0].version === 2 && list[1].version === 1);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
