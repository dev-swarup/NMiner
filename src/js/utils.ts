type EventMap = Record<string, any[]>;
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

    public async emit<K extends keyof Events>(event: K, ...args: Events[K]): Promise<void> {
        const k = event as string;
        const list = this.listeners[k];
        if (!list || list.length === 0) return;

        await Promise.all(list.map(l => l(...args)));
    };

    public once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        const onceWrapper = async (...args: Events[K]) => {
            this.off(event, onceWrapper as any);
            await listener(...args);
        };

        return this.on(event, onceWrapper as any);
    };
};