import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** Resolves queue names to URLs once and caches them (queues are provisioned outside the app). */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  get(name: string): Promise<string> {
    let url = this.cache.get(name);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: name })).then(({ QueueUrl }) => {
        if (!QueueUrl) throw new Error(`queue ${name} not found`);
        return QueueUrl;
      });
      url.catch(() => this.cache.delete(name));
      this.cache.set(name, url);
    }
    return url;
  }
}
