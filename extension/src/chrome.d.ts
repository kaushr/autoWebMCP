/**
 * Minimal ambient declarations for the Chrome extension APIs this project
 * actually uses. Declaring them locally keeps `tsc --noEmit` honest without
 * adding a dependency for a handful of call sites.
 */
declare namespace chrome {
  namespace runtime {
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function sendMessage<TResponse = unknown>(message: unknown): Promise<TResponse>;
    type MessageListener = (
      message: unknown,
      sender: { tab?: { id?: number; url?: string } },
      sendResponse: (response?: unknown) => void
    ) => boolean | undefined | void;
    const onMessage: {
      addListener(callback: MessageListener): void;
      /** Needed by the content script, which replaces its own listener on re-injection. */
      removeListener(callback: MessageListener): void;
    };
    const onInstalled: { addListener(callback: () => void): void };
    const onStartup: { addListener(callback: () => void): void };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      status?: string;
    }
    function query(query: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function sendMessage<TResponse = unknown>(tabId: number, message: unknown): Promise<TResponse>;
    const onUpdated: {
      addListener(
        callback: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void
      ): void;
    };
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }

  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files: string[];
    }): Promise<unknown>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
    function setTitle(details: { title: string; tabId?: number }): Promise<void>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }

  namespace webRequest {
    interface RequestFilter {
      urls: string[];
      tabId?: number;
    }
    interface RequestDetails {
      requestId: string;
      url: string;
      method: string;
      tabId: number;
      frameId?: number;
      type: string;
      timeStamp: number;
      statusCode?: number;
      /** Origin of the document that triggered the request, when Chrome exposes it. */
      initiator?: string;
      fromCache?: boolean;
      /** Present on onErrorOccurred only. */
      error?: string;
    }
    type RequestListener = (details: RequestDetails) => void;
    interface RequestEvent {
      addListener(callback: RequestListener, filter: RequestFilter): void;
      removeListener(callback: RequestListener): void;
    }
    const onBeforeRequest: RequestEvent;
    const onCompleted: RequestEvent;
    const onErrorOccurred: RequestEvent;
  }
}
