import { Model } from 'objection';
import BaseModel from './base';
// eslint-disable-next-line import/no-cycle
import { Event } from './event';

export class EventAttribute extends BaseModel {
  event_id!: number;

  key!: string;

  value!: string;

  composite_key!: string;

  block_height!: number;

  tx_id!: number;

  static get tableName() {
    return 'event_attribute';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['event_id', 'key', 'value'],
      properties: {
        event_id: { type: 'number' },
        key: { type: 'string' },
        value: { type: 'string' },
        composite_key: { type: 'string' },
        block_height: { type: 'number' },
        tx_id: { type: 'number' },
      },
    };
  }

  static get relationMappings() {
    return {
      event: {
        relation: Model.BelongsToOneRelation,
        modelClass: Event,
        join: {
          from: 'event_attribute.event_id',
          to: 'event.id',
        },
      },
    };
  }

  static ATTRIBUTE_KEY = {
    BALANCES: 'balances',
    DELEGATION_RESPONSES: 'delegation_responses',
    REDELEGATION_RESPONSES: 'redelegation_responses',
    UNBONDING_RESPONSES: 'unbonding_responses',
    ACTION: 'action',
    TRANSFER: 'transfer',
    SENDER: 'sender',
    RECEIVER: 'receiver',
    SPENDER: 'spender',
    RECIPIENT: 'recipient',
    COIN_RECEIVED: 'coin_received',
    COIN_SPENT: 'coin_spent',
    WITHDRAW_REWARDS: 'withdraw_rewards',
    AMOUNT: 'amount',
    VALIDATOR: 'validator',
    SOURCE_VALIDATOR: 'source_validator',
    DESTINATION_VALIDATOR: 'destination_validator',
    RECV_PACKET: 'recv_packet',
    PACKET_DATA: 'packet_data',
    _CONTRACT_ADDRESS: '_contract_address',
    CODE_ID: 'code_id',
    PROPOSAL_ID: 'proposal_id',
    STAKING: 'staking',
    DELEGATE: 'delegate',
    REDELEGATE: 'redelegate',
    UNBOND: 'unbond',
  };
}
