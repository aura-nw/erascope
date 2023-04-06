import { Model } from 'objection';
import BaseModel from './base';

export class TransactionMessageReceiver extends BaseModel {
  tx_msg_id!: number;

  address!: string;

  reason: string | undefined;

  static get tableName() {
    return 'transaction_message_receiver';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['tx_msg_id', 'address'],
      properties: {
        tx_msg_id: { type: 'number' },
        address: { type: 'string' },
        reason: { type: 'string' },
      },
    };
  }

  static get relationMappings() {
    return {
      owner: {
        relation: Model.BelongsToOneRelation,
        modelClass: 'transaction_message',
        join: {
          from: 'transaction_message_receiver.tx_msg_id',
          to: 'transaction_message.id',
        },
      },
    };
  }
}
