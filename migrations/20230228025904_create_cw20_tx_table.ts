import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.createTable('cw20_txs', (table) => {
    table.increments();
    table.string('tx_hash').index();
    table.string('from').index();
    table.string('to').index();
    table.bigInteger('amount');
    table.string('action');
    table.string('contract_address').index();
    table
      .foreign('contract_address')
      .references('cw20_tokens.contract_address');
    table.timestamp('created_at').notNullable().defaultTo(knex.raw('now()'));
    table.timestamp('updated_at').notNullable().defaultTo(knex.raw('now()'));
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.dropTable('cw20_txs');
}
