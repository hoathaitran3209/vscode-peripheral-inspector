/********************************************************************************
 * Copyright (C) 2023 Marcel Ball, Arm Limited and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License as outlined in the LICENSE File
 ********************************************************************************/

import * as vscode from 'vscode';

const DEBUG_TRACKER_EXTENSION = 'mcu-debug.debug-tracker-vscode';

interface IDebuggerTrackerEvent {
    event: DebugSessionStatus;
    session?: vscode.DebugSession;
    sessionId?: string;
}

interface IDebuggerTrackerSubscribeArgBodyV1 {
    debuggers: string[] | '*';
    handler: (arg: IDebuggerTrackerEvent) => Promise<void>;
}

interface IDebuggerTrackerSubscribeArg {
    version: number;
    body: IDebuggerTrackerSubscribeArgBodyV1;
}

interface IDebugTracker {
    subscribe(arg: IDebuggerTrackerSubscribeArg): void;
}

export enum DebugSessionStatus {
    Unknown = 'unknown',
    Initializing = 'initializing',
    Started = 'started',
    Stopped = 'stopped',
    Running = 'running',
    Terminated = 'terminated'
}

export class DebugTracker {
    /** The tracker of the latest debug adapter started for each session. */
    private sessionTrackers = new Map<string, object>();
    /**
     * The user already stopped this session.
     * A late launch success must not publish a tree. Cleared only for a restart,
     * when a new adapter start arrives after this mark and VS Code then starts the session.
     */
    private readonly sessionIdsEndedBeforeStart = new Set<string>();
    /** Adapter start that arrived after the session was already stopped. Replay it only on a real restart. */
    private readonly suppressedStartSessions = new Map<string, vscode.DebugSession>();
    /** Stop was already emitted for this end. DAP terminated and the session-end event both report it. */
    private readonly stopNotifiedSessionIds = new Set<string>();

    public constructor(private debugType = '*') {
    }

    private _onWillStartSession: vscode.EventEmitter<vscode.DebugSession> = new vscode.EventEmitter<vscode.DebugSession>();
    public readonly onWillStartSession: vscode.Event<vscode.DebugSession> = this._onWillStartSession.event;

    private _onWillStopSession: vscode.EventEmitter<string | vscode.DebugSession> = new vscode.EventEmitter<string | vscode.DebugSession>();
    public readonly onWillStopSession: vscode.Event<string | vscode.DebugSession> = this._onWillStopSession.event;

    private _onDidStopDebug: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onDidStopDebug: vscode.Event<string> = this._onDidStopDebug.event;

    private _onDidContinueDebug: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();
    public readonly onDidContinueDebug: vscode.Event<string> = this._onDidContinueDebug.event;

    public async activate(context: vscode.ExtensionContext): Promise<void> {
        /**
         * Register two listeners for debug session and a tracker for debug adapter events.
        */
        context.subscriptions.push(
            vscode.debug.onDidTerminateDebugSession(session => {
                // Restart reuses the session id. This event also fires for the old adapter,
                // after the new adapter has been stored in sessionTrackers.
                if (this.sessionTrackers.has(session.id)) {
                    return;
                }
                this.trackerSessionEnded(session.id);
                this.handleOnWillStopSession(session);
            }),
            vscode.debug.onDidStartDebugSession(session => {
                const suppressed = this.suppressedStartSessions.get(session.id);
                this.suppressedStartSessions.delete(session.id);
                if (!suppressed) {
                    return;
                }
                this.sessionIdsEndedBeforeStart.delete(session.id);
                this.handleOnWillStartSession(suppressed);
            }),
        );

        const debugtracker = await this.getTracker();
        if (debugtracker) {
            // Use shared debug tracker extension
            debugtracker.subscribe({
                version: 1,
                body: {
                    debuggers: '*',
                    handler: async event => {
                        const sessionId = event.session?.id ?? event.sessionId;
                        if (event.event === DebugSessionStatus.Initializing && event.session) {
                            this.handleOnWillStartSession(event.session);
                        }
                        if (event.event === DebugSessionStatus.Terminated && sessionId) {
                            // The shared tracker reports the same VS Code event. A live adapter
                            // belongs to a restart and must keep its tree.
                            if (!this.sessionTrackers.has(sessionId)) {
                                this.handleOnWillStopSession(sessionId);
                            }
                        }
                        if (event.event === DebugSessionStatus.Stopped && sessionId) {
                            this.handleOnDidStopDebug(sessionId);
                        }
                        if (event.event === DebugSessionStatus.Running && sessionId) {
                            this.handleOnDidContinueDebug(sessionId);
                        }
                    }
                }
            });

            context.subscriptions.push(
                vscode.debug.registerDebugAdapterTrackerFactory(this.debugType, {
                    createDebugAdapterTracker: session => this.createAdapterTracker(session, false)
                })
            );
        } else {
            context.subscriptions.push(
                vscode.debug.registerDebugAdapterTrackerFactory(this.debugType, {
                    createDebugAdapterTracker: session => this.createAdapterTracker(session, true)
                })
            );
        }
    }

    private createAdapterTracker(session: vscode.DebugSession, watchRunState: boolean): vscode.DebugAdapterTracker {
        const tracker = {};
        // vscode.debug.activeDebugConsole.appendLine(`[PI] Creating adapter tracker for session ${session.id}.`);
        // Record the tracker before onWillStartSession. Stop can win before that callback.
        this.sessionTrackers.set(session.id, tracker);
        return {
            onWillStartSession: () => {
                if (this.sessionTrackers.get(session.id) !== tracker) {
                    return;
                }
                this.handleOnWillStartSession(session);
            },
            onWillStopSession: () => {
                if (this.sessionTrackers.get(session.id) !== tracker) {
                    return;
                }
                this.sessionTrackers.delete(session.id);
                this.trackerSessionEnded(session.id);
                this.handleOnWillStopSession(session);
            },
            onDidSendMessage: message => {
                if (this.sessionTrackers.get(session.id) !== tracker) {
                    return;
                }
                if (message.type !== 'event') {
                    return;
                }
                if (message.event === 'terminated' && !message.body?.restart) {
                    this.trackerSessionEnded(session.id);
                    this.handleOnWillStopSession(session);
                }
                if (!watchRunState) {
                    return;
                }
                if (message.event === 'stopped') {
                    this.handleOnDidStopDebug(session.id);
                }
                if (message.event === 'continued') {
                    this.handleOnDidContinueDebug(session.id);
                }
            }
        };
    }

    /**
     * The user already stopped this session. A tree for it must be removed, and a start
     * still in flight must not publish one.
     */
    public ignoreSessionStart(sessionId: string): boolean {
        return this.sessionIdsEndedBeforeStart.has(sessionId);
    }

    private trackerSessionEnded(sessionId: string): void {
        this.sessionIdsEndedBeforeStart.add(sessionId);
        // Drop a restart start only when this adapter itself stopped.
        // onDidTerminateDebugSession does not call this while a newer adapter is live.
        this.suppressedStartSessions.delete(sessionId);
    }

    private handleOnWillStartSession(session: vscode.DebugSession): void {
        if (this.sessionIdsEndedBeforeStart.has(session.id)) {
            this.suppressedStartSessions.set(session.id, session);
            return;
        }
        this.stopNotifiedSessionIds.delete(session.id);
        this._onWillStartSession.fire(session);
    }

    private handleOnWillStopSession(session: string | vscode.DebugSession): void {
        const sessionId = typeof session === 'string' ? session : session.id;
        if (this.stopNotifiedSessionIds.has(sessionId)) {
            return;
        }
        this.stopNotifiedSessionIds.add(sessionId);
        this._onWillStopSession.fire(session);
    }

    private handleOnDidStopDebug(session: string): void {
        this._onDidStopDebug.fire(session);
    }

    private handleOnDidContinueDebug(session: string): void {
        this._onDidContinueDebug.fire(session);
    }

    private async getTracker(): Promise<IDebugTracker | undefined> {
        try {
            const trackerExtension = vscode.extensions.getExtension<IDebugTracker>(DEBUG_TRACKER_EXTENSION);
            if (trackerExtension) {
                return trackerExtension.activate();
            }
        } catch {
            // Ignore error
        }

        return undefined;
    }
}
