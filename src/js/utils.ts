type EventMap = Record<string, any[]>;

const NOOP = (): void => { };
const DONE: Promise<void> = Promise.resolve();

export class EventEmitter<Events extends EventMap> {
    private listeners: { [key: string]: Array<(...args: any[]) => void | Promise<void>> } = Object.create(null);

    public on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        const k = event as string;
        if (!this.listeners[k]) this.listeners[k] = [];

        this.listeners[k].push(listener);
        return this;
    };

    public off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        const k = event as string;
        const list = this.listeners[k];

        if (!list) return this;

        const idx = list.indexOf(listener as any);
        if (idx !== -1) list.splice(idx, 1);

        return this;
    };

    public removeAllListeners<K extends keyof Events>(event?: K): this {
        if (event === undefined) 
            this.listeners = Object.create(null);
        else 
            delete this.listeners[event as string];

        return this;
    };

    public emit<K extends keyof Events>(event: K, ...args: Events[K]): Promise<void> {
        const list = this.listeners[event as string];
        if (!list || list.length === 0) return DONE;

        let waits: Array<Promise<void>> | null = null;

        for (const listener of list.length === 1 ? list : [...list]) {
            let result: void | Promise<void>;

            try { result = listener(...args); } catch { continue; };
            if (result) (waits ??= []).push(result.then(NOOP, NOOP));
        };

        return waits ? Promise.all(waits).then(NOOP) : DONE;
    };

    public once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        const onceWrapper = async (...args: Events[K]) => {
            this.off(event, onceWrapper as any);
            await listener(...args);
        };

        return this.on(event, onceWrapper as any);
    };
};