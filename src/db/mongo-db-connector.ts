import { Db, MongoClient, MongoClientOptions } from "mongodb";
import { MongoDbDatabase } from "../types/mongo.js";

export type MongoDbConnectorOptions = {
  connectionString: string;
  clientOptions?: MongoClientOptions;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class MongoDbConnector {
  readonly #client: MongoClient;
  readonly #connectPromise: Promise<MongoClient>;
  #closed = false;

  constructor(options: MongoDbConnectorOptions) {
    const { connectionString, clientOptions, onError, onOpen, onClose } = options;

    const mongoClient = new MongoClient(connectionString, clientOptions);

    mongoClient.on("error", (error) => {
      onError?.(error);
    });

    mongoClient.on("open", () => {
      onOpen?.();
    });

    mongoClient.on("close", () => {
      onClose?.();
    });

    this.#connectPromise = mongoClient.connect();
    this.#client = mongoClient;
  }

  async isHealthy(): Promise<boolean> {
    if (this.#closed) return false;

    try {
      await this.#connectPromise;
      await this.#client.db("admin").command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  getDb(name: MongoDbDatabase): Db {
    return this.#client.db(name);
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      const client = await this.#connectPromise;
      await client.close();
    } catch {
      // Connection already failed — nothing to close
    }
  }
}
