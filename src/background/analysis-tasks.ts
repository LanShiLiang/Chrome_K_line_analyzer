import { createAbortError } from '../shared/cancellation';

type AnalysisTask = { id: string; controller: AbortController };

export class AnalysisTaskRegistry {
  private readonly tasks = new Map<number, AnalysisTask>();

  start(tabId: number, id: string): AbortSignal {
    this.cancel(tabId);
    const controller = new AbortController();
    this.tasks.set(tabId, { id, controller });
    return controller.signal;
  }

  cancel(tabId: number): boolean {
    const task = this.tasks.get(tabId);
    if (!task) return false;
    this.tasks.delete(tabId);
    task.controller.abort(createAbortError());
    return true;
  }

  complete(tabId: number, id: string) {
    if (this.tasks.get(tabId)?.id === id) this.tasks.delete(tabId);
  }

  has(tabId: number) {
    return this.tasks.has(tabId);
  }
}
