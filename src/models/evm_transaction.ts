import { Model } from 'objection';
import BaseModel from './base';
import { TransactionMessage } from './transaction_message';
import { Transaction } from './transaction';

export class EVMTransaction extends BaseModel {
  id!: number;

  hash!: string;

  height!: number;

  from!: string;

  to!: string;

  size!: string;

  value!: string;

  gas!: bigint;

  gas_fee_cap!: bigint;

  gas_tip_cap!: bigint;

  data!: string;

  nonce!: bigint;

  tx_msg_id!: number;

  tx_id!: number;

  static get tableName() {
    return 'evm_transaction';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['hash', 'height'],
      properties: {
        hash: { type: 'string' },
        height: { type: 'number' },
      },
    };
  }

  static get relationMappings() {
    return {
      transaction_message: {
        relation: Model.BelongsToOneRelation,
        modelClass: TransactionMessage,
        join: {
          from: 'evm_transaction.tx_msg_id',
          to: 'transaction_message.id',
        },
      },
      transaction: {
        relation: Model.BelongsToOneRelation,
        modelClass: Transaction,
        join: {
          from: 'evm_transaction.tx_id',
          to: 'transaction.id',
        },
      },
    };
  }
}
