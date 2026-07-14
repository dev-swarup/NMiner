type EventMap = Record<string, any[]>;
export class EventEmitter<Events extends EventMap> {
    private listeners: { [K in keyof Events]?: Array<(...args: Events[K]) => void | Promise<void>>; } = {};

    public on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event]!.push(listener);

        return this;
    };

    public off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        if (!this.listeners[event])
            return this;

        this.listeners[event] = this.listeners[event]!.filter(l => l !== listener);

        return this;
    };

    public async emit<K extends keyof Events>(event: K, ...args: Events[K]): Promise<void> {
        if (!this.listeners[event])
            return;

        const Listeners = [...this.listeners[event]!];
        await Promise.all(Listeners.map(listener => listener(...args)));
    };

    public once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void | Promise<void>): this {
        const onceWrapper = async (...args: Events[K]) => {
            this.off(event, onceWrapper);
            await listener(...args);
        };

        return this.on(event, onceWrapper);
    };
};