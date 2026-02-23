import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';

// --- IoT Configuration ---

let iotConfig = {
  mqttBrokerUrl: 'mqtt://localhost:1883',
  homeAssistantUrl: 'http://localhost:8123',
  homeAssistantToken: '',
};

export function configureIot(config: Partial<typeof iotConfig>): void {
  iotConfig = { ...iotConfig, ...config };
}

// --- MQTT Publish Tool ---

const mqttPublishInputSchema = z.object({
  topic: z.string().describe('MQTT topic to publish to'),
  payload: z.string().describe('Message payload (string or JSON)'),
  qos: z.number().min(0).max(2).default(0).describe('Quality of service (0, 1, or 2)'),
  retain: z.boolean().default(false).describe('Whether to retain the message'),
});

export const iotMqttPublishTool: ToolDefinition = {
  name: 'iot_mqtt_publish',
  description: 'Publish a message to an MQTT topic for IoT device control',
  inputSchema: mqttPublishInputSchema,
  outputSchema: z.object({ success: z.boolean(), topic: z.string() }),
  tags: ['iot', 'mqtt'],
  async execute(input) {
    const parsed = input as z.infer<typeof mqttPublishInputSchema>;
    const mqttMod = 'mqtt';
    const mqtt = await import(/* @vite-ignore */ mqttMod);

    const client = mqtt.connect(iotConfig.mqttBrokerUrl);

    return new Promise((resolve, reject) => {
      client.on('connect', () => {
        client.publish(parsed.topic, parsed.payload, {
          qos: parsed.qos as 0 | 1 | 2,
          retain: parsed.retain,
        }, (err: any) => {
          client.end();
          if (err) reject(err);
          else resolve({ success: true, topic: parsed.topic });
        });
      });

      client.on('error', (err: Error) => {
        client.end();
        reject(err);
      });

      // Timeout
      setTimeout(() => {
        client.end();
        reject(new Error('MQTT connection timeout'));
      }, 10_000);
    });
  },
};

// --- MQTT Subscribe Tool ---

const mqttSubscribeInputSchema = z.object({
  topic: z.string().describe('MQTT topic to subscribe to'),
  timeout: z.number().default(5000).describe('How long to listen for messages (ms)'),
  maxMessages: z.number().default(10).describe('Maximum messages to collect'),
});

export const iotMqttSubscribeTool: ToolDefinition = {
  name: 'iot_mqtt_subscribe',
  description: 'Subscribe to an MQTT topic and collect messages from IoT devices',
  inputSchema: mqttSubscribeInputSchema,
  outputSchema: z.object({
    messages: z.array(z.object({
      topic: z.string(),
      payload: z.string(),
      timestamp: z.string(),
    })),
    count: z.number(),
  }),
  tags: ['iot', 'mqtt'],
  async execute(input) {
    const parsed = input as z.infer<typeof mqttSubscribeInputSchema>;
    const mqttMod = 'mqtt';
    const mqtt = await import(/* @vite-ignore */ mqttMod);

    const client = mqtt.connect(iotConfig.mqttBrokerUrl);
    const messages: Array<{ topic: string; payload: string; timestamp: string }> = [];

    return new Promise((resolve, reject) => {
      client.on('connect', () => {
        client.subscribe(parsed.topic, (err: any) => {
          if (err) {
            client.end();
            reject(err);
          }
        });
      });

      client.on('message', (topic: string, payload: Buffer) => {
        messages.push({
          topic,
          payload: payload.toString('utf-8'),
          timestamp: new Date().toISOString(),
        });
        if (messages.length >= parsed.maxMessages) {
          client.end();
          resolve({ messages, count: messages.length });
        }
      });

      client.on('error', (err: Error) => {
        client.end();
        reject(err);
      });

      setTimeout(() => {
        client.end();
        resolve({ messages, count: messages.length });
      }, parsed.timeout);
    });
  },
};

// --- Home Assistant Control Tool ---

const haControlInputSchema = z.object({
  entityId: z.string().describe('Home Assistant entity ID (e.g., light.living_room, switch.fan)'),
  service: z.string().describe('Service to call (e.g., turn_on, turn_off, toggle)'),
  domain: z.string().optional().describe('Service domain (auto-detected from entity ID if omitted)'),
  data: z.record(z.unknown()).optional().describe('Additional service data (e.g., { brightness: 255 })'),
});

export const iotHomeAssistantControlTool: ToolDefinition = {
  name: 'smart_home_control',
  description: 'Control a smart home device via Home Assistant (lights, switches, climate, etc.)',
  inputSchema: haControlInputSchema,
  outputSchema: z.object({
    success: z.boolean(),
    entityId: z.string(),
    service: z.string(),
    state: z.string().optional(),
  }),
  tags: ['iot', 'smart-home'],
  async execute(input) {
    const parsed = input as z.infer<typeof haControlInputSchema>;

    const domain = parsed.domain || parsed.entityId.split('.')[0];
    const url = `${iotConfig.homeAssistantUrl}/api/services/${domain}/${parsed.service}`;

    const body: Record<string, unknown> = { entity_id: parsed.entityId };
    if (parsed.data) {
      Object.assign(body, parsed.data);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${iotConfig.homeAssistantToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Home Assistant API error (${response.status}): ${errorText}`);
    }

    return {
      success: true,
      entityId: parsed.entityId,
      service: parsed.service,
    };
  },
};

// --- Home Assistant Status Tool ---

const haStatusInputSchema = z.object({
  entityId: z.string().optional().describe('Specific entity ID to query, or omit for all entities'),
  domain: z.string().optional().describe('Filter by domain (e.g., light, switch, sensor)'),
});

export const iotHomeAssistantStatusTool: ToolDefinition = {
  name: 'smart_home_status',
  description: 'Get the current state of smart home devices from Home Assistant',
  inputSchema: haStatusInputSchema,
  outputSchema: z.object({
    entities: z.array(z.object({
      entityId: z.string(),
      state: z.string(),
      attributes: z.record(z.unknown()),
      lastChanged: z.string(),
    })),
    count: z.number(),
  }),
  tags: ['iot', 'smart-home'],
  async execute(input) {
    const parsed = input as z.infer<typeof haStatusInputSchema>;

    let url = `${iotConfig.homeAssistantUrl}/api/states`;
    if (parsed.entityId) {
      url = `${iotConfig.homeAssistantUrl}/api/states/${parsed.entityId}`;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${iotConfig.homeAssistantToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Home Assistant API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Single entity
    if (parsed.entityId) {
      return {
        entities: [{
          entityId: data.entity_id,
          state: data.state,
          attributes: data.attributes || {},
          lastChanged: data.last_changed || '',
        }],
        count: 1,
      };
    }

    // All entities (optionally filtered by domain)
    let entities = (data as any[]).map((e: any) => ({
      entityId: e.entity_id,
      state: e.state,
      attributes: e.attributes || {},
      lastChanged: e.last_changed || '',
    }));

    if (parsed.domain) {
      entities = entities.filter((e) => e.entityId.startsWith(`${parsed.domain}.`));
    }

    return { entities, count: entities.length };
  },
};
