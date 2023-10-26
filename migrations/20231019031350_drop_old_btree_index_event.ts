import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('event', (table) => {
    table.dropIndex('block_height', 'event_block_height_index');
    table.dropIndex('tx_id', 'transaction_event_tx_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('event', (table) => {
    table.index('block_height', 'event_block_height_index', 'btree');
    table.index('tx_id', 'transaction_event_tx_id_index', 'btree');
  });
}
