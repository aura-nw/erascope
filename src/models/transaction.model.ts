import { Model } from 'objection';
import BaseModel from './base.model';

export interface Transaction {
  height: number;
  hash: string;
  codespace: string;
  code: number;
  gas_used: number;
  gas_wanted: number;
  gas_limit: number;
  fee: number;
  timstamp: Date;
  data: JSON;
}

export class Transaction extends BaseModel implements Transaction {
  height!: number;

  hash!: string;

  codespace!: string;

  code!: number;

  gas_used!: number;

  gas_wanted!: number;

  gas_limit!: number;

  fee!: number;

  timstamp!: Date;

  data!: JSON;

  static get tableName() {
    return 'transaction';
  }

  static get jsonAttributes() {
    return ['data'];
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: [
        'height',
        'hash',
        'codespace',
        'code',
        'gas_used',
        'gas_wanted',
        'gas_limit',
        'fee',
        'timestamp',
        'data',
      ],
      properties: {
        height: { type: 'number' },
        hash: { type: 'string' },
        codespace: { type: 'string' },
        code: { type: 'number' },
        gas_used: { type: 'number' },
        gas_wanted: { type: 'number' },
        gas_limit: { type: 'number' },
        fee: { type: 'number' },
        timestamp: { type: 'timestamp' },
        data: {
          type: 'object',
          patternProperties: {
            '^.*$': {
              anyOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
      },
    };
  }

  static get relationMappings() {
    return {
      owner: {
        relation: Model.BelongsToOneRelation,
        modelClass: 'block',
        join: {
          from: 'transaction.height',
          to: 'block.height',
        },
      },
      messages: {
        relation: Model.HasManyRelation,
        modelClass: 'transaction_message',
        join: {
          from: 'transaction.hash',
          to: 'transaction_message.tx_hash',
        },
      },
      events: {
        relation: Model.HasManyRelation,
        modelClass: 'transaction_event',
        join: {
          from: 'transaction.hash',
          to: 'transaction_event.tx_hash',
        },
      },
    };
  }
}
