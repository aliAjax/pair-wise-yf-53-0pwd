import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked' | 'stale';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
  /** 确认时快照的仓库版本；登记新版本后该快照失效，门禁需重新确认 */
  confirmedVersion?: string;
  /** 确认时快照的上游依赖仓库版本（仅当上游仓库在本次列车内时记录） */
  confirmedUpstreamVersion?: string;
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

/** 从 dependency 字段解析上游仓库名，如 gateway@2.12 -> gateway */
export function dependencyRepoName(dependency: string): string {
  return dependency.split('@')[0].trim();
}

export function findGateByRepo(gates: RepositoryGate[], repo: string): RepositoryGate | undefined {
  return gates.find((item) => item.repository === repo);
}

/** 门禁当前是否“作数”：已确认，且确认时快照的版本与上游依赖版本均未变化 */
export function isGateEffective(gate: RepositoryGate, gates: RepositoryGate[]): boolean {
  if (gate.status !== 'confirmed') return false;
  if (gate.confirmedVersion !== gate.version) return false;
  const upstream = findGateByRepo(gates, dependencyRepoName(gate.dependency));
  if (upstream && gate.confirmedUpstreamVersion !== undefined && gate.confirmedUpstreamVersion !== upstream.version) return false;
  return true;
}

/** 门禁失效原因，用于界面提示；未失效返回 undefined */
export function gateStaleReason(gate: RepositoryGate, gates: RepositoryGate[]): string | undefined {
  if (gate.status !== 'confirmed') return undefined;
  if (gate.confirmedVersion !== gate.version) return `仓库版本已从 ${gate.confirmedVersion ?? '?'} 变更为 ${gate.version}，确认已失效`;
  const upstream = findGateByRepo(gates, dependencyRepoName(gate.dependency));
  if (upstream && gate.confirmedUpstreamVersion !== undefined && gate.confirmedUpstreamVersion !== upstream.version) {
    return `上游 ${upstream.repository} 版本已从 ${gate.confirmedUpstreamVersion} 变更为 ${upstream.version}，确认已失效`;
  }
  return undefined;
}

/** 顺序是否合法：每个门禁的上游依赖仓库都必须排在它前面 */
export function isOrderValid(gates: RepositoryGate[]): boolean {
  const indexByRepo = new Map(gates.map((item, index) => [item.repository, index]));
  return gates.every((gate, index) => {
    const upstreamIndex = indexByRepo.get(dependencyRepoName(gate.dependency));
    return upstreamIndex === undefined || upstreamIndex < index;
  });
}

/** 把 activeId 拖到 overId 位置后顺序是否仍合法（用于拖拽前即时判定，非法则不移动、退回原顺序） */
export function reorderValid(gates: RepositoryGate[], activeId: string, overId: string): boolean {
  const from = gates.findIndex((item) => item.id === activeId);
  const to = gates.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0) return false;
  const next = [...gates];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return isOrderValid(next);
}

/** 冻结是否就绪：所有门禁均已重新确认（有效），且没有未关闭的严重阻断项 */
export function freezeReady(train: ReleaseTrain | undefined): boolean {
  if (!train) return false;
  const allEffective = train.gates.length > 0 && train.gates.every((gate) => isGateEffective(gate, train.gates));
  const criticalOpen = train.blockers.some((item) => !item.resolved && item.severity === 'critical');
  return allEffective && !criticalOpen;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', confirmedVersion: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'pending', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

function now() { return new Date().toLocaleTimeString(); }

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({ id, ...action.payload, status: 'preparing', gates: [], blockers: [], audit: [{ id: `a-${Date.now()}`, at: now(), text: '创建发布列车' }] });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      gate.status = 'confirmed';
      gate.confirmedVersion = gate.version;
      const upstream = findGateByRepo(train.gates, dependencyRepoName(gate.dependency));
      gate.confirmedUpstreamVersion = upstream ? upstream.version : undefined;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `${gate.repository} 门禁由发布负责人确认（版本 ${gate.version}）` });
    },
    registerVersion(state, action: PayloadAction<{ id: string; version: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.id);
      if (!train || !gate) return;
      const nextVersion = action.payload.version.trim();
      if (!nextVersion || nextVersion === gate.version) return;
      const previous = gate.version;
      gate.version = nextVersion;
      // 本仓库换了新版本：本仓库门禁的确认针对的是旧版本，立即失效
      if (gate.status === 'confirmed') {
        gate.status = 'stale';
        gate.confirmedVersion = undefined;
        gate.confirmedUpstreamVersion = undefined;
      }
      // 依赖该仓库的门禁：上游版本一变，确认立即失效，需重新确认
      const affected: string[] = [];
      for (const other of train.gates) {
        if (other.id === gate.id) continue;
        if (dependencyRepoName(other.dependency) === gate.repository && other.status === 'confirmed') {
          other.status = 'stale';
          other.confirmedVersion = undefined;
          other.confirmedUpstreamVersion = undefined;
          affected.push(other.repository);
        }
      }
      const detail = affected.length ? `，依赖它的门禁（${affected.join('、')}）确认已失效` : '';
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `${gate.repository} 登记新版本 ${previous} → ${nextVersion}${detail}，需重新确认后才能参与冻结` });
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (action.payload === 'frozen' && !freezeReady(train)) {
        const reasons: string[] = [];
        const notReady = train.gates.filter((gate) => !isGateEffective(gate, train.gates));
        if (notReady.length) reasons.push(`${notReady.map((gate) => gate.repository).join('、')} 门禁未重新确认`);
        const criticalOpen = train.blockers.some((item) => !item.resolved && item.severity === 'critical');
        if (criticalOpen) reasons.push('存在未关闭的严重阻断项');
        train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `冻结被阻止：${reasons.join('；')}` });
        return;
      }
      train.status = action.payload;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `状态调整为 ${action.payload}` });
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      blocker.resolved = true;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `阻断项已关闭：${blocker.title}` });
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const next = [...train.gates];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      if (!isOrderValid(next)) {
        train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `顺序调整被拒绝：${moved.repository} 不能排到其上游依赖之前，已退回原顺序` });
        return;
      }
      train.gates = next;
      train.audit.unshift({ id: `a-${Date.now()}`, at: now(), text: `调整 ${moved.repository} 的发布顺序` });
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
export const { activateTrain, confirmGate, createTrain, reorderGates, registerVersion, replaceState, resolveBlocker, setFreeze } = trainSlice.actions;

/** 兼容旧存档：已确认但缺少版本快照的门禁，按当前版本补齐快照，避免重开后状态变成另一套 */
function migrate(raw: TrainState): TrainState {
  for (const train of raw.trains) {
    for (const gate of train.gates) {
      if (gate.status === 'confirmed' && gate.confirmedVersion === undefined) gate.confirmedVersion = gate.version;
    }
  }
  return raw;
}

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) store.dispatch(replaceState(migrate(JSON.parse(saved) as TrainState)));
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
