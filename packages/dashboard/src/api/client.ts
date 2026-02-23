const BASE_URL = '';

export async function fetchTasks() {
  const res = await fetch(`${BASE_URL}/tasks`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.statusText}`);
  return res.json();
}

export async function fetchTask(id: string) {
  const res = await fetch(`${BASE_URL}/tasks/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch task: ${res.statusText}`);
  return res.json();
}

export async function fetchTaskTrace(id: string) {
  const res = await fetch(`${BASE_URL}/tasks/${id}/trace`);
  if (!res.ok) throw new Error(`Failed to fetch trace: ${res.statusText}`);
  return res.json();
}

export async function fetchTools() {
  const res = await fetch(`${BASE_URL}/tools`);
  if (!res.ok) throw new Error(`Failed to fetch tools: ${res.statusText}`);
  return res.json();
}

export async function fetchHealth() {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.statusText}`);
  return res.json();
}

export async function submitTask(description: string, budget: string = 'medium') {
  const res = await fetch(`${BASE_URL}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, budget }),
  });
  if (!res.ok) throw new Error(`Failed to submit task: ${res.statusText}`);
  return res.json();
}

export function streamTask(description: string, budget: string = 'medium') {
  return new EventSource(`${BASE_URL}/tasks/stream?description=${encodeURIComponent(description)}&budget=${budget}`);
}

export async function fetchChannelStatus() {
  const res = await fetch(`${BASE_URL}/health/channels`);
  if (!res.ok) throw new Error(`Failed to fetch channels: ${res.statusText}`);
  return res.json();
}

export async function fetchMetrics() {
  const res = await fetch(`${BASE_URL}/health/metrics`);
  if (!res.ok) throw new Error(`Failed to fetch metrics: ${res.statusText}`);
  return res.json();
}
