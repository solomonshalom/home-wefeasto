/*
 * Direct Postgres access to the slot database, for "time travel" the HTTP API can't do
 * (expire a reservation, make a queued job due). Parameterised queries only. Table and
 * column names are Payload's snake_case (orders.reserved_until, payload_jobs.wait_until…).
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { CMS_DIR } from '../../../scripts/e2e/config.mjs';

const { Pool } = createRequire(path.join(CMS_DIR, 'package.json'))('pg');

export class Db {
	constructor(dbUri) {
		this.dbUri = dbUri;
		this.pool = null;
	}

	/** rows of a parameterised query. */
	async query(sql, params = []) {
		this.pool ??= new Pool({ connectionString: this.dbUri, max: 3 });
		return (await this.pool.query(sql, params)).rows;
	}

	/** The raw orders row (snake_case columns) or null. */
	async order(number) {
		return (await this.query('select * from orders where number = $1', [number]))[0] ?? null;
	}

	/**
	 * Put an online order's reservation `minutesAgo` minutes in the past (so the next
	 * reconcile run treats it as abandoned / expired). Resolves the new reserved_until.
	 */
	async expireReservation(number, { minutesAgo = 5 } = {}) {
		const rows = await this.query(
			'update orders set reserved_until = now() - make_interval(mins => $2) where number = $1 returning reserved_until',
			[number, Math.trunc(minutesAgo)]
		);
		if (!rows.length) throw new Error(`db.expireReservation: no order ${number}`);
		return rows[0].reserved_until;
	}

	/** Move an order's created_at back by `minutes` (supersede window, reconcile age filters). */
	async backdateOrder(number, { minutes }) {
		const rows = await this.query(
			'update orders set created_at = created_at - make_interval(mins => $2) where number = $1 returning created_at',
			[number, Math.trunc(minutes)]
		);
		if (!rows.length) throw new Error(`db.backdateOrder: no order ${number}`);
		return rows[0].created_at;
	}

	/**
	 * Queued Payload jobs, optionally for one order (input.number) and/or task slug:
	 * [{ id, task_slug, input, wait_until, completed_at, has_error, processing, total_tried }].
	 */
	async jobs({ orderNumber, task } = {}) {
		return this.query(
			`select id, task_slug::text as task_slug, input, wait_until, completed_at, has_error, processing, total_tried
			   from payload_jobs
			  where ($1::text is null or input->>'number' = $1)
			    and ($2::text is null or task_slug::text = $2)
			  order by id`,
			[orderNumber ?? null, task ?? null]
		);
	}

	/** Make matching unfinished jobs due now (wait_until = now - 1 min). Resolves their ids. */
	async makeJobsDue({ orderNumber, task } = {}) {
		const rows = await this.query(
			`update payload_jobs set wait_until = now() - interval '1 minute'
			  where completed_at is null
			    and ($1::text is null or input->>'number' = $1)
			    and ($2::text is null or task_slug::text = $2)
			  returning id`,
			[orderNumber ?? null, task ?? null]
		);
		return rows.map((r) => r.id);
	}

	/** Current stock of a product (exact, server-only). */
	async stock(slug) {
		const r = await this.query('select stock from products where slug = $1', [slug]);
		return r.length ? Number(r[0].stock) : null;
	}

	async close() {
		if (this.pool) await this.pool.end().catch(() => {});
		this.pool = null;
	}
}
