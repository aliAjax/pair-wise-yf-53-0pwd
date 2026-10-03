import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, confirmGate, createTrain, reorderGates, registerVersion, resolveBlocker, setFreeze,
  useGetTrainHealthQuery, gateStaleReason, isGateEffective, isOrderValid, reorderValid,
  type RepositoryGate, type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const badgeColor: Record<RepositoryGate['status'], string> = {
  confirmed: 'green',
  pending: 'yellow',
  blocked: 'red',
  stale: 'orange'
};
const badgeLabel: Record<RepositoryGate['status'], string> = {
  confirmed: '已确认',
  pending: '待确认',
  blocked: '已阻断',
  stale: '已失效'
};

function VersionForm({ onRegister }: { onRegister: (version: string) => void }) {
  const [value, setValue] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    onRegister(value.trim());
    setValue('');
  }
  return (
    <form onSubmit={submit}>
      <Group gap={4}>
        <TextInput size="xs" w={116} placeholder="登记新版本号" value={value} onChange={(event) => setValue(event.currentTarget.value)} />
        <Button size="xs" variant="light" type="submit">登记新版本</Button>
      </Group>
    </form>
  );
}

function SortableGate({ gate, gates, onConfirm, onRegister }: { gate: RepositoryGate; gates: RepositoryGate[]; onConfirm: () => void; onRegister: (version: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  const staleReason = gate.status === 'stale' ? gateStaleReason(gate, gates) : undefined;
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 当前版本 {gate.version}</Text>
          {gate.status === 'confirmed' && <Text size="xs" c="green">确认于版本 {gate.confirmedVersion}</Text>}
          {gate.status === 'stale' && <Text size="xs" c="orange">确认已失效{staleReason ? `：${staleReason}` : ''}，需重新确认后才能参与冻结</Text>}
        </div>
        <Group>
          <Badge color={badgeColor[gate.status]}>{badgeLabel[gate.status]}</Badge>
          <VersionForm onRegister={onRegister} />
          <Button
            size="xs"
            variant={gate.status === 'stale' ? 'filled' : 'light'}
            color={gate.status === 'stale' ? 'orange' : undefined}
            onClick={onConfirm}
            disabled={gate.status === 'confirmed' || gate.status === 'blocked'}
          >
            {gate.status === 'stale' ? '重新确认' : '确认门禁'}
          </Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
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
  const [dragError, setDragError] = useState('');

  if (!train) return null;

  const effectiveCount = train.gates.filter((gate) => isGateEffective(gate, train.gates)).length;
  const criticalOpen = train.blockers.filter((item) => !item.resolved && item.severity === 'critical').length;
  const orderValid = isOrderValid(train.gates);
  const freezeReady = train.gates.length > 0 && effectiveCount === train.gates.length && criticalOpen === 0 && orderValid;
  const notReadyGates = train.gates.filter((gate) => !isGateEffective(gate, train.gates));

  function onDragEnd(event: DragEndEvent) {
    setDragError('');
    if (!event.over || event.active.id === event.over.id) return;
    if (!reorderValid(train.gates, String(event.active.id), String(event.over.id))) {
      const moved = train.gates.find((item) => item.id === String(event.active.id));
      setDragError(`顺序调整被退回：${moved?.repository ?? ''} 不能排到其上游依赖之前。`);
      return;
    }
    dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>门禁确认与仓库版本、依赖顺序联动：版本一变确认即失效，顺序排错自动退回，全部确认且无严重阻断才能冻结。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3} c={freezeReady ? 'green' : undefined}>{effectiveCount}/{train.gates.length}</Title><Progress mt="sm" value={train.gates.length ? effectiveCount / train.gates.length * 100 : 0} /></Card>
        <Card withBorder><Text size="xs">未关闭严重阻断</Text><Title order={3} c={criticalOpen ? 'red' : 'green'}>{criticalOpen}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批顺序，下游不得排到上游之前</Text></Group>
            {dragError && <Alert color="red" mb="md" onClose={() => setDragError('')} withCloseButton>{dragError}</Alert>}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => (
                  <SortableGate
                    key={gate.id}
                    gate={gate}
                    gates={train.gates}
                    onConfirm={() => dispatch(confirmGate(gate.id))}
                    onRegister={(version) => dispatch(registerVersion({ id: gate.id, version }))}
                  />
                ))}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Stack gap="xs" mt="md" mb="md">
              <Text size="sm" c={effectiveCount === train.gates.length ? 'green' : 'red'}>
                门禁确认 {effectiveCount}/{train.gates.length}{effectiveCount === train.gates.length ? '，全部有效' : notReadyGates.length ? `（${notReadyGates.map((item) => item.repository).join('、')} 待重新确认）` : ''}
              </Text>
              <Text size="sm" c={criticalOpen ? 'red' : 'green'}>严重阻断 {criticalOpen} 项未关闭</Text>
              <Text size="sm" c={orderValid ? 'green' : 'red'}>分批顺序{orderValid ? '合法' : '存在冲突'}</Text>
            </Stack>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))} disabled={!freezeReady}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
            {!freezeReady && <Text size="xs" c="dimmed" mt="sm">门禁全部重新确认、关闭所有严重阻断项后才允许冻结。</Text>}
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
