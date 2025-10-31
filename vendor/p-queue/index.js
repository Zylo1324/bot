class PQueue {
  constructor(options = {}) {
    const { concurrency = 1 } = options;
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new TypeError('concurrency must be a positive integer');
    }
    this.concurrency = concurrency;
    this.queue = [];
    this.activeCount = 0;
  }

  add(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('Task must be a function returning a promise or value');
    }

    return new Promise((resolve, reject) => {
      const task = () => Promise.resolve().then(fn);
      this.queue.push({ task, resolve, reject });
      this._dequeue();
    });
  }

  _dequeue() {
    if (this.activeCount >= this.concurrency) {
      return;
    }

    const nextItem = this.queue.shift();
    if (!nextItem) {
      return;
    }

    this.activeCount += 1;
    nextItem
      .task()
      .then((value) => {
        nextItem.resolve(value);
      })
      .catch((error) => {
        nextItem.reject(error);
      })
      .finally(() => {
        this.activeCount -= 1;
        if (this.queue.length > 0) {
          this._dequeue();
        }
      });
  }
}

export default PQueue;
