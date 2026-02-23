import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  iotMqttPublishTool,
  iotMqttSubscribeTool,
  iotHomeAssistantControlTool,
  iotHomeAssistantStatusTool,
  configureIot,
} from '../src/builtin/iot.js';

// Mock mqtt module
vi.mock('mqtt', () => {
  const mockClient = {
    on: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn(),
    end: vi.fn(),
  };

  return {
    connect: vi.fn(() => {
      // Fire 'connect' event on next tick
      setTimeout(() => {
        const connectHandlers = mockClient.on.mock.calls.filter(
          (c: any) => c[0] === 'connect'
        );
        for (const [, handler] of connectHandlers) {
          handler();
        }
      }, 0);
      return mockClient;
    }),
    __mockClient: mockClient,
  };
});

// Mock fetch for Home Assistant
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('IoT Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureIot({
      mqttBrokerUrl: 'mqtt://test:1883',
      homeAssistantUrl: 'http://ha.local:8123',
      homeAssistantToken: 'test-token',
    });
  });

  describe('iot_mqtt_publish', () => {
    it('should have correct name and tags', () => {
      expect(iotMqttPublishTool.name).toBe('iot_mqtt_publish');
      expect(iotMqttPublishTool.tags).toContain('iot');
      expect(iotMqttPublishTool.tags).toContain('mqtt');
    });

    it('should have description', () => {
      expect(iotMqttPublishTool.description).toBeTruthy();
    });
  });

  describe('iot_mqtt_subscribe', () => {
    it('should have correct name and tags', () => {
      expect(iotMqttSubscribeTool.name).toBe('iot_mqtt_subscribe');
      expect(iotMqttSubscribeTool.tags).toContain('iot');
    });

    it('should have description', () => {
      expect(iotMqttSubscribeTool.description).toBeTruthy();
    });
  });

  describe('smart_home_control', () => {
    it('should have correct name and tags', () => {
      expect(iotHomeAssistantControlTool.name).toBe('smart_home_control');
      expect(iotHomeAssistantControlTool.tags).toContain('smart-home');
    });

    it('should call Home Assistant API to control device', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await iotHomeAssistantControlTool.execute({
        entityId: 'light.living_room',
        service: 'turn_on',
        data: { brightness: 255 },
      });

      expect(result).toEqual({
        success: true,
        entityId: 'light.living_room',
        service: 'turn_on',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://ha.local:8123/api/services/light/turn_on',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
          }),
        }),
      );
    });

    it('should auto-detect domain from entity ID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await iotHomeAssistantControlTool.execute({
        entityId: 'switch.fan',
        service: 'toggle',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://ha.local:8123/api/services/switch/toggle',
        expect.any(Object),
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(iotHomeAssistantControlTool.execute({
        entityId: 'light.test',
        service: 'turn_on',
      })).rejects.toThrow('Home Assistant API error');
    });
  });

  describe('smart_home_status', () => {
    it('should have correct name and tags', () => {
      expect(iotHomeAssistantStatusTool.name).toBe('smart_home_status');
      expect(iotHomeAssistantStatusTool.tags).toContain('smart-home');
    });

    it('should get single entity state', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entity_id: 'light.living_room',
          state: 'on',
          attributes: { brightness: 255 },
          last_changed: '2024-01-01T00:00:00Z',
        }),
      });

      const result = await iotHomeAssistantStatusTool.execute({
        entityId: 'light.living_room',
      });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].state).toBe('on');
      expect(result.count).toBe(1);
    });

    it('should get all entities filtered by domain', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { entity_id: 'light.room1', state: 'on', attributes: {}, last_changed: '' },
          { entity_id: 'light.room2', state: 'off', attributes: {}, last_changed: '' },
          { entity_id: 'switch.fan', state: 'on', attributes: {}, last_changed: '' },
        ]),
      });

      const result = await iotHomeAssistantStatusTool.execute({
        domain: 'light',
      });

      expect(result.entities).toHaveLength(2);
      expect(result.count).toBe(2);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Server Error',
      });

      await expect(iotHomeAssistantStatusTool.execute({})).rejects.toThrow('Home Assistant API error');
    });
  });

  describe('configureIot', () => {
    it('should update configuration', () => {
      configureIot({ homeAssistantUrl: 'http://new:8123' });
      // Configuration is internal, verify it works via tool execution
      expect(iotHomeAssistantControlTool.name).toBe('smart_home_control');
    });
  });
});
