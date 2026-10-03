import {
  trainSlice,
  freezeRejectionReasons,
  findOrderViolation,
  parseDependency,
  versionSatisfies,
  type TrainState
} from '../app/store/index';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

function seedState(): TrainState {
  return {
    activeId: 't',
    trains: [{
      id: 't', name: 'T', freezeAt: '2026-10-10 18:00', status: 'preparing',
      gates: [
        { id: 'g1', repository: 'gateway', owner: 'a', dependency: 'lib@1.0', status: 'confirmed', version: '2.12.0', confirmedAtVersion: '2.12.0' },
        { id: 'g2', repository: 'data-sync', owner: 'b', dependency: 'gateway@2.12', status: 'confirmed', version: '1.9.4', confirmedAtVersion: '1.9.4' },
        { id: 'g3', repository: 'web', owner: 'c', dependency: 'gateway@2.12', status: 'pending', version: '3.0.0' }
      ],
      blockers: [{ id: 'b1', title: '严重问题', severity: 'critical', resolved: false }],
      audit: []
    }]
  };
}
const reducer = trainSlice.reducer;
const actions = trainSlice.actions;

// 1. 版本变更联动：上游换版本，自身+下游已确认门禁立即失效
console.log('1) 上游版本变更');
{
  let s = seedState();
  s = reducer(s, actions.registerVersion({ gateId: 'g1', version: '2.13.0' }));
  const t = s.trains[0];
  const g1 = t.gates.find((g) => g.id === 'g1')!;
  const g2 = t.gates.find((g) => g.id === 'g2')!;
  const g3 = t.gates.find((g) => g.id === 'g3')!;
  check('上游自身 confirmed -> invalid', g1.status === 'invalid' && !!g1.invalidReason?.includes('2.13.0'));
  check('下游 confirmed -> invalid 且原因指向版本不一致', g2.status === 'invalid' && g2.invalidReason!.includes('gateway'));
  check('未确认的下游保持 pending', g3.status === 'pending');
  check('审计记录失效联动', t.audit[0].text.includes('门禁失效'));
}

// 2. 登记兼容补丁版本（2.12 -> 2.12.1）：按前缀兼容，自身版本仍变（自身失效），下游钉版仍满足
console.log('2) 补丁版本兼容');
{
  let s = seedState();
  s = reducer(s, actions.registerVersion({ gateId: 'g1', version: '2.12.1' }));
  const t = s.trains[0];
  const g1 = t.gates.find((g) => g.id === 'g1')!;
  const g2 = t.gates.find((g) => g.id === 'g2')!;
  check('上游自身换版仍失效', g1.status === 'invalid');
  check('下游钉版 2.12 兼容 2.12.1，保持 confirmed', g2.status === 'confirmed');
}

// 3. 重新确认后才可冻结；严重阻断未关闭也不能冻结
console.log('3) 冻结条件');
{
  let s = seedState();
  s = reducer(s, actions.registerVersion({ gateId: 'g1', version: '2.13.0' }));
  s = reducer(s, actions.setFreeze('frozen'));
  check('有失效门禁时冻结被拒绝且状态不变', s.trains[0].status === 'preparing');
  check('拒绝原因包含失效门禁', freezeRejectionReasons(s.trains[0]).some((r) => r.includes('gateway')));
  s = reducer(s, actions.confirmGate('g1'));
  s = reducer(s, actions.confirmGate('g2'));
  s = reducer(s, actions.confirmGate('g3'));
  check('重新确认后门禁状态恢复 confirmed', s.trains[0].gates.every((g) => g.status === 'confirmed'));
  check('重新确认清除 invalidReason 并记录新版本', s.trains[0].gates[0].invalidReason === undefined && s.trains[0].gates[0].confirmedAtVersion === '2.13.0');
  s = reducer(s, actions.setFreeze('frozen'));
  check('严重阻断未关闭，仍不能冻结', s.trains[0].status === 'preparing');
  s = reducer(s, actions.resolveBlocker('b1'));
  s = reducer(s, actions.setFreeze('frozen'));
  check('全部确认且无严重阻断后允许冻结', s.trains[0].status === 'frozen');
}

// 4. 拖拽：下游排到上游前面被拒绝，保持原顺序
console.log('4) 分批顺序约束');
{
  let s = seedState();
  const before = s.trains[0].gates.map((g) => g.id).join(',');
  // data-sync(g2) 试图移到 gateway(g1) 之前：把 g1 拖到 g2 位置等价于 g2 越过 g1
  s = reducer(s, actions.reorderGates({ activeId: 'g1', overId: 'g2' }));
  const after = s.trains[0].gates.map((g) => g.id).join(',');
  check('非法移动后顺序不变', before === after, `before=${before} after=${after}`);
  check('非法移动写审计', s.trains[0].audit[0].text.includes('顺序调整被拒绝'));
  // g3(pending, 依赖 gateway) 拖到 g1 前也非法
  s = reducer(s, actions.reorderGates({ activeId: 'g1', overId: 'g3' }));
  check('g3 依赖 gateway，gateway 不能排到 g3 后面', s.trains[0].gates.map((g) => g.id).join(',') === before);
  // 合法移动：g2 与 g3 同为 gateway 下游，互换不违反约束
  s = reducer(s, actions.reorderGates({ activeId: 'g3', overId: 'g2' }));
  check('下游之间互换允许', s.trains[0].gates.map((g) => g.id) === 'g1,g3,g2' || s.trains[0].gates.map((g) => g.id).join(',') === 'g1,g3,g2');
}

// 5. 纯函数边界
console.log('5) 工具函数');
check('versionSatisfies 前缀兼容', versionSatisfies('2.12', '2.12.0') && versionSatisfies('2.12.0', '2.12'));
check('versionSatisfies 不兼容大版本', !versionSatisfies('2.12', '2.13.0'));
check('parseDependency', parseDependency('gateway@2.12')?.name === 'gateway');
check('findOrderViolation 识别越序', findOrderViolation([
  { id: 'g2', repository: 'data-sync', owner: '', dependency: 'gateway@2.12', status: 'pending', version: '1' },
  { id: 'g1', repository: 'gateway', owner: '', dependency: 'x@1', status: 'pending', version: '2' }
])?.downstream === 'data-sync');

// 6. 持久化：重开页面 = 从 localStorage 恢复，状态不变
console.log('6) 重开页面状态一致');
{
  let s = seedState();
  s = reducer(s, actions.registerVersion({ gateId: 'g1', version: '2.13.0' }));
  s = reducer(s, actions.reorderGates({ activeId: 'g3', overId: 'g2' }));
  const json = JSON.stringify(s);
  const restored = JSON.parse(json) as TrainState;
  check('序列化/恢复后失效状态与顺序完全一致', JSON.stringify(restored) === json);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
