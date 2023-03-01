import { Model } from 'objection';
import BaseModel from './BaseModel';

export interface TransactionEventAttribute {
  event_id: number;
  key: string;
  value: string;
}

export class TransactionEventAttribute
  extends BaseModel
  implements TransactionEventAttribute
{
  event_id!: number;

  key!: string;

  value!: string;

  static get tableName() {
    return 'transaction_event_attribute';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['event_id', 'key', 'value'],
      properties: {
        event_id: { type: 'number' },
        key: { type: 'string' },
        value: { type: 'string' },
      },
    };
  }

  static get relationMappings() {
    return {
      owner: {
        relation: Model.BelongsToOneRelation,
        modelClass: 'transaction_event',
        join: {
          from: 'transaction_event_attribute.event_id',
          to: 'transaction_event.id',
        },
      },
    };
  }
}
