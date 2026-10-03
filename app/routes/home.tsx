import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, List, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  confirmGate,
  createTrain,
  dependencyMismatch,
  findOrderViolation,
  freezeRejectionReasons,
  reorderGates,
  registerVersion,
  resolveBlocker,
  setFreeze,
  useGetTrainHealthQuery,
  type GateStatus,
  type RepositoryGate,
  type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const statusLabel: Record<GateStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  blocked: '受阻',
  invalid: '已失效'
};
const statusColor: Record<GateStatus, string> = {
  pending: 'yellow',
  confirmed: 'green',
  blocked: 'red',
  invalid: 'orange'
};

function SortableGate({ gate, mismatch, onConfirm, onRegisterVersion }: {
  gate: RepositoryGate;
  mismatch: string | null;
  onConfirm: () => void;
  onRegisterVersion: (version: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  const [nextVersion, setNextVersion] = useState('');
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Text fw={700}>{gate.repository}</Text>
            <Badge color={statusColor[gate.status]}>{statusLabel[gate.status]}</Badge>
          </Group>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 当前版本 {gate.version}</Text>
          {gate.status === 'invalid' && gate.invalidReason && (
            <Alert color="orange" variant="light" mt="xs" py={6} icon={<span>⚠️</span>} title="该门禁不作数，须重新确认">
              {gate.invalidReason}
            </Alert>
          )}
          {gate.status !== 'invalid' && mismatch && (
            <Text size="sm" c="orange" mt={4}>⚠ {mismatch}，确认前请核对</Text>
          )}
        </div>
        <Group>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>
            {gate.status === 'invalid' ? '重新确认' : '确认门禁'}
          </Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
      <Group mt="sm" gap="xs">
        <TextInput
          size="xs"
          placeholder="登记新版本，如 2.13.0"
          value={nextVersion}
          onChange={(event) => setNextVersion(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && nextVersion.trim()) {
              event.preventDefault();
              onRegisterVersion(nextVersion.trim());
              setNextVersion('');
            }
          }}
          style={{ flex: 1 }}
        />
        <Button size="xs" variant="default" disabled={!nextVersion.trim() || nextVersion.trim() === gate.version} onClick={() => { onRegisterVersion(nextVersion.trim()); setNextVersion(''); }}>
          登记新版本
        </Button>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const [orderError, setOrderError] = useState<string | null>(null);

  if (!train) return null;

  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const criticalOpen = train.blockers.filter((item) => !item.resolved && item.severity === 'critical').length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const invalid = train.gates.filter((item) => item.status === 'invalid').length;
  const rejectionReasons = freezeRejectionReasons(train);

  function onDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    // 先按目标位置预演：下游排到上游前面时拒绝，reducer 同样拒绝并写审计，列表保持原顺序
    const from = train!.gates.findIndex((item) => item.id === activeId);
    const to = train!.gates.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0) return;
    const preview = [...train!.gates];
    const [moved] = preview.splice(from, 1);
    preview.splice(to, 0, moved);
    const violation = findOrderViolation(preview);
    if (violation) {
      setOrderError(`下游 ${violation.downstream} 不能排到上游 ${violation.upstream} 之前，已退回原顺序`);
    } else {
      setOrderError(null);
    }
    dispatch(reorderGates({ activeId, overId }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。上游版本变更会立即作废相关门禁；全部门禁重新确认且无未关闭严重阻断项，才允许冻结。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder>
          <Text size="xs">门禁已确认</Text>
          <Title order={3} c={invalid ? 'orange' : undefined}>{confirmed}/{train.gates.length}{invalid > 0 ? ` · ${invalid} 失效` : ''}</Title>
          <Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} color={invalid ? 'orange' : 'blue'} />
        </Card>
        <Card withBorder>
          <Text size="xs">未关闭阻断项</Text>
          <Title order={3} c={criticalOpen ? 'red' : unresolved ? 'yellow' : 'green'}>{unresolved}{criticalOpen > 0 ? `（严重 ${criticalOpen}）` : ''}</Title>
        </Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>跨仓库依赖门禁</Title>
              <Text size="sm" c="dimmed">拖动调整分批发布顺序（下游不能排到上游前面）</Text>
            </Group>
            {orderError && <Alert color="red" variant="light" mb="md" onClose={() => setOrderError(null)} withCloseButton>{orderError}</Alert>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>
                  {train.gates.map((gate) => (
                    <SortableGate
                      key={gate.id}
                      gate={gate}
                      mismatch={dependencyMismatch(train.gates, gate)}
                      onConfirm={() => dispatch(confirmGate(gate.id))}
                      onRegisterVersion={(version) => { dispatch(registerVersion({ gateId: gate.id, version })); setOrderError(null); }}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity === 'critical' ? '严重' : '警告'}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">发布控制</Title>
            {rejectionReasons.length > 0 ? (
              <>
                <Text size="sm" fw={700} c="red" mb={4}>冻结条件未满足：</Text>
                <List size="sm" mb="md" spacing={4}>
                  {rejectionReasons.map((reason) => <List.Item key={reason} c="red">{reason}</List.Item>)}
                </List>
              </>
            ) : (
              <Text size="sm" c="green" mb="md">所有门禁已确认，且无未关闭的严重阻断项，可以冻结。</Text>
            )}
            <Group>
              <Button onClick={() => dispatch(setFreeze('frozen'))} disabled={rejectionReasons.length > 0}>冻结列车</Button>
              <Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button>
              <Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button>
            </Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
