import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cw721_contract', (table) => {
    table.increments('id').primary();
    table.string('code_id').index().notNullable();
    table.string('address').unique().index().notNullable();
    table.string('name').index().notNullable();
    table.string('symbol');
    table.string('minter');
    table.string('creator');
  });

  await knex.schema.createTable('cw721_token', (table) => {
    table.increments('id').primary();
    table.string('token_id').index().notNullable();
    table.string('token_uri');
    table.jsonb('extension');
    table.string('owner');
    table.string('contract_address').index().notNullable();
    table.integer('last_updated_height').index();
    table.unique(['token_id', 'contract_address', 'last_updated_height']);
    table.foreign('contract_address').references('cw721_contract.address');
    table.boolean('burned').defaultTo(false);
  });

  await knex.schema.createTable('cw721_token_history', (table) => {
    table.increments('id').primary();
    table.string('tx_hash').index().notNullable();
    table.string('sender').index();
    table.string('action');
    table.string('contract_address').index().notNullable();
    table.string('token_id').index();
    table.string('owner');
    table.integer('height');
    table.unique(['tx_hash', 'contract_address', 'action', 'token_id']);
    table.foreign('contract_address').references('cw721_contract.address');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('cw721_token_history');
  await knex.schema.dropTable('cw721_token');
  await knex.schema.dropTable('cw721_contract');
}
