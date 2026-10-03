import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked' | 'invalid';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  /** 形如 gateway@2.12 的钉版依赖；指向本列车内仓库时参与顺序与失效判定 */
  dependency: string;
  status: GateStatus;
  version: string;
  /** 门禁失效原因（上游或自身版本变更），重新确认后清除 */
  invalidReason?: string;
  /** 最近一次确认时登记的版本，用于区分确认后是否换过版本 */
  confirmedAtVersion?: string;
}
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', confirmedAtVersion: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

let auditSeq = 0;
function auditEntry(text: string) {
  auditSeq += 1;
  return { id: `a-${Date.now()}-${auditSeq}`, at: new Date().toLocaleTimeString(), text };
}

/** 解析 repo@version 形式的钉版依赖 */
export function parseDependency(dependency: string): { name: string; version: string } | null {
  const at = dependency.indexOf('@');
  if (at <= 0) return null;
  const name = dependency.slice(0, at).trim();
  const version = dependency.slice(at + 1).trim();
  if (!name || !version) return null;
  return { name, version };
}

/** 钉版与当前版本按前缀兼容：2.12 匹配 2.12.0，2.12.0 匹配 2.12 */
export function versionSatisfies(pin: string, current: string): boolean {
  return pin === current || current.startsWith(`${pin}.`) || pin.startsWith(`${current}.`);
}

/** 依赖是否落在本列车内（外部仓库不参与门禁联动） */
export function findUpstreamGate(gates: RepositoryGate[], dependency: string): RepositoryGate | undefined {
  const dep = parseDependency(dependency);
  if (!dep) return undefined;
  return gates.find((gate) => gate.repository === dep.name);
}

/** 依赖与上游当前版本不一致时返回提示文案；外部依赖或一致时返回 null */
export function dependencyMismatch(gates: RepositoryGate[], gate: RepositoryGate): string | null {
  const dep = parseDependency(gate.dependency);
  if (!dep) return null;
  const upstream = gates.find((item) => item.repository === dep.name);
  if (!upstream || versionSatisfies(dep.version, upstream.version)) return null;
  return `依赖钉版 ${gate.dependency} 与上游 ${upstream.repository} 当前版本 ${upstream.version} 不一致`;
}

export interface OrderViolation {
  upstream: string;
  downstream: string;
}

/**
 * 校验给定门禁顺序：下游仓库不能排到它依赖的上游仓库前面。
 * 只统计依赖指向本列车内仓库的边。
 */
export function findOrderViolation(orderedGates: RepositoryGate[]): OrderViolation | null {
  const position = new Map(orderedGates.map((gate, index) => [gate.id, index]));
  for (const gate of orderedGates) {
    const upstream = findUpstreamGate(orderedGates, gate.dependency);
    if (upstream && (position.get(upstream.id) ?? 0) > (position.get(gate.id) ?? 0)) {
      return { upstream: upstream.repository, downstream: gate.repository };
    }
  }
  return null;
}

/** 冻结前的硬性条件：全部门禁已确认（无 pending/blocked/invalid）且无未关闭严重阻断项 */
export function freezeRejectionReasons(train: ReleaseTrain): string[] {
  const reasons: string[] = [];
  if (train.gates.length === 0) reasons.push('列车尚未关联任何仓库门禁');
  for (const gate of train.gates) {
    if (gate.status === 'confirmed') continue;
    if (gate.status === 'invalid') reasons.push(`门禁 ${gate.repository} 已失效：${gate.invalidReason ?? '上游版本发生变化'}，需重新确认`);
    else if (gate.status === 'blocked') reasons.push(`门禁 ${gate.repository} 仍处于受阻状态，需确认`);
    else reasons.push(`门禁 ${gate.repository} 尚未确认`);
  }
  for (const blocker of train.blockers) {
    if (!blocker.resolved && blocker.severity === 'critical') reasons.push(`存在未关闭的严重阻断项：${blocker.title}`);
  }
  return reasons;
}

export const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({ id, ...action.payload, status: 'preparing', gates: [], blockers: [], audit: [auditEntry('创建发布列车')] });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      const wasInvalid = gate.status === 'invalid';
      gate.status = 'confirmed';
      gate.invalidReason = undefined;
      gate.confirmedAtVersion = gate.version;
      train.audit.unshift(auditEntry(`${gate.repository} 门禁${wasInvalid ? '重新' : ''}由发布负责人确认（版本 ${gate.version}）`));
    },
    registerVersion(state, action: PayloadAction<{ gateId: string; version: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      const version = action.payload.version.trim();
      if (!version || version === gate.version) return;
      const oldVersion = gate.version;
      gate.version = version;

      // 仓库自身版本一变，它自己已确认的门禁立即失效
      const invalidated: string[] = [];
      if (gate.status === 'confirmed') {
        gate.status = 'invalid';
        gate.invalidReason = `仓库版本由 ${oldVersion} 变更为 ${version}，原确认已失效`;
        invalidated.push(gate.repository);
      }

      // 依赖它的下游门禁：钉版与新版本不一致时立即失效，需重新确认
      for (const dependent of train.gates) {
        if (dependent.id === gate.id) continue;
        const dep = parseDependency(dependent.dependency);
        if (!dep || dep.name !== gate.repository || dependent.status !== 'confirmed') continue;
        if (versionSatisfies(dep.version, version)) continue;
        dependent.status = 'invalid';
        dependent.invalidReason = `上游 ${gate.repository} 版本变更为 ${version}，与钉版 ${dep.version} 不一致，原确认已失效`;
        invalidated.push(dependent.repository);
      }

      train.audit.unshift(auditEntry(
        `${gate.repository} 登记新版本 ${oldVersion} → ${version}` +
        (invalidated.length ? `，${invalidated.join('、')} 门禁失效，须重新确认后方可冻结` : '，无需联动失效的门禁')
      ));
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (action.payload === 'frozen') {
        const reasons = freezeRejectionReasons(train);
        if (reasons.length > 0) {
          train.audit.unshift(auditEntry(`冻结被拒绝：${reasons.join('；')}`));
          return;
        }
      }
      train.status = action.payload;
      train.audit.unshift(auditEntry(`状态调整为 ${action.payload}`));
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift(auditEntry(`阻断项已关闭：${blocker.title}`));
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;

      // 先在副本上形成目标顺序并做上下游校验，非法移动不落库，保持原顺序
      const next = [...train.gates];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      const violation = findOrderViolation(next);
      if (violation) {
        train.audit.unshift(auditEntry(`顺序调整被拒绝：下游 ${violation.downstream} 不能排到上游 ${violation.upstream} 之前，已退回原顺序`));
        return;
      }
      train.gates = next;
      train.audit.unshift(auditEntry(`调整 ${moved.repository} 的分批发布顺序`));
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const { activateTrain, confirmGate, createTrain, registerVersion, reorderGates, replaceState, resolveBlocker, setFreeze } = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
