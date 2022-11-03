import { Column, MigrationMeta, param, sql, Table } from 'drizzle-orm';
import { Name, PreparedQuery, SQL, SQLResponse, SQLSourceParam } from 'drizzle-orm/sql';
import { AnySQLiteColumn, SQLiteColumn } from '~/columns';
import { SQLiteDatabase } from '~/db';
import { SQLiteSelectFields, SQLiteSelectFieldsOrdered } from '~/operations';
import {
	SQLiteDeleteConfig,
	SQLiteInsertConfig,
	SQLiteSelectConfig,
	SQLiteUpdateConfig,
	SQLiteUpdateSet,
} from '~/queries';
import { SQLiteSession } from '~/session';
import { AnySQLiteTable, SQLiteTable } from '~/table';

export class SQLiteDialect {
	migrate(migrations: MigrationMeta[], session: SQLiteSession): void {
		// const migrations = sqliteTable('drizzle_migrations', {
		// 	id:
		// });

		const migrationTableCreate = sql`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)`;
		session.run(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
		session.run(migrationTableCreate);

		const dbMigrations = session.all<[number, string, string]>(
			sql`SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`,
		);

		const lastDbMigration = dbMigrations[0] ?? undefined;
		session.run(sql`BEGIN`);

		try {
			for (const migration of migrations) {
				if (!lastDbMigration || parseInt(lastDbMigration[2], 10)! < migration.folderMillis) {
					session.run(sql.raw(migration.sql));
					session.run(
						sql`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`,
					);
				}
			}

			session.run(sql`COMMIT`);
		} catch (e) {
			session.run(sql`ROLLBACK`);
			throw e;
		}
	}

	createDB(session: SQLiteSession): SQLiteDatabase {
		return new SQLiteDatabase(this, session);
	}

	escapeName(name: string): string {
		return `"${name}"`;
	}

	escapeParam(num: number): string {
		return '?';
	}

	buildDeleteQuery({ table, where, returning }: SQLiteDeleteConfig): SQL {
		const returningSql = returning
			? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
			: undefined;

		const whereSql = where ? sql` where ${where}` : undefined;

		return sql`delete from ${table}${whereSql}${returningSql}`;
	}

	buildUpdateSet(table: AnySQLiteTable, set: SQLiteUpdateSet): SQL {
		const setEntries = Object.entries(set);

		const setSize = setEntries.length;
		return sql.fromList(
			setEntries
				.map(([colName, value], i): SQL[] => {
					const col: AnySQLiteColumn = table[Table.Symbol.Columns][colName]!;
					const res = sql`${new Name(col.name)} = ${value}`;
					if (i < setSize - 1) {
						return [res, sql.raw(', ')];
					}
					return [res];
				})
				.flat(1),
		);
	}

	orderSelectedFields(fields: SQLiteSelectFields<string>, resultTableName: string): SQLiteSelectFieldsOrdered {
		return Object.entries(fields).map(([name, field]) => ({ name, resultTableName, field }));
	}

	buildUpdateQuery({ table, set, where, returning }: SQLiteUpdateConfig): SQL {
		const setSql = this.buildUpdateSet(table, set);

		const returningSql = returning
			? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
			: undefined;

		const whereSql = where ? sql` where ${where}` : undefined;

		return sql`update ${table} set ${setSql}${whereSql}${returningSql}`;
	}

	/**
	 * Builds selection SQL with provided fields/expressions
	 *
	 * Examples:
	 *
	 * `select <selection> from`
	 *
	 * `insert ... returning <selection>`
	 *
	 * If `isSingleTable` is true, then columns won't be prefixed with table name
	 */
	private buildSelection(
		fields: SQLiteSelectFieldsOrdered,
		{ isSingleTable = false }: { isSingleTable?: boolean } = {},
	): SQL {
		const columnsLen = fields.length;

		const chunks = fields
			.map(({ field }, i) => {
				const chunk: SQLSourceParam[] = [];

				if (field instanceof SQLResponse) {
					if (isSingleTable) {
						chunk.push(
							new SQL(
								field.sql.queryChunks.map((c) => {
									if (c instanceof SQLiteColumn) {
										return new Name(c.name);
									}
									return c;
								}),
							),
						);
					} else {
						chunk.push(field.sql);
					}
				} else if (field instanceof Column) {
					if (isSingleTable) {
						chunk.push(new Name(field.name));
					} else {
						chunk.push(field);
					}
				}

				if (i < columnsLen - 1) {
					chunk.push(sql`, `);
				}

				return chunk;
			})
			.flat(1);

		return sql.fromList(chunks);
	}

	buildSelectQuery({ fields, where, table, joins, orderBy, limit, offset }: SQLiteSelectConfig): SQL {
		const joinKeys = Object.keys(joins);

		const selection = this.buildSelection(fields, { isSingleTable: joinKeys.length === 0 });

		const joinsArray: SQL[] = [];

		joinKeys.forEach((tableAlias, index) => {
			if (index === 0) {
				joinsArray.push(sql` `);
			}
			const joinMeta = joins[tableAlias]!;
			const table = joinMeta.table;
			const tableName = table[Table.Symbol.Name];
			const origTableName = table[SQLiteTable.Symbol.OriginalName];
			const alias = tableName === origTableName ? undefined : tableAlias;
			joinsArray.push(
				sql`${sql.raw(joinMeta.joinType)} join ${new Name(origTableName)} ${
					alias && new Name(alias)
				} on ${joinMeta.on}`,
			);
			if (index < joinKeys.length - 1) {
				joinsArray.push(sql` `);
			}
		});

		const joinsSql = sql.fromList(joinsArray);

		const whereSql = where ? sql` where ${where}` : undefined;

		const orderByList: SQL[] = [];
		orderBy.forEach((orderByValue, index) => {
			orderByList.push(orderByValue);

			if (index < orderBy.length - 1) {
				orderByList.push(sql`, `);
			}
		});

		const orderBySql = orderByList.length > 0 ? sql` order by ${sql.fromList(orderByList)}` : undefined;

		const limitSql = limit ? sql` limit ${limit}` : undefined;

		const offsetSql = offset ? sql` offset ${offset}` : undefined;

		return sql`select ${selection} from ${table}${joinsSql}${whereSql}${orderBySql}${limitSql}${offsetSql}`;
	}

	buildInsertQuery({ table, values, onConflict, returning }: SQLiteInsertConfig): SQL {
		const valuesSqlList: ((SQLSourceParam | SQL)[] | SQL)[] = [];
		const columns: Record<string, AnySQLiteColumn> = table[Table.Symbol.Columns];
		const colEntries = Object.entries(columns);
		const insertOrder = colEntries.map(([, column]) => new Name(column.name));

		values.forEach((value, valueIndex) => {
			const valueList: (SQLSourceParam | SQL)[] = [];
			colEntries.forEach(([colKey, col]) => {
				const colValue = value[colKey];
				if (typeof colValue === 'undefined') {
					let defaultValue;
					if (col.default !== null && col.default !== undefined) {
						if (col.default instanceof SQL) {
							defaultValue = col.default;
						} else {
							defaultValue = param(col.default, col);
						}
					} else {
						defaultValue = sql`null`;
					}
					valueList.push(defaultValue);
				} else {
					valueList.push(colValue);
				}
			});
			valuesSqlList.push(valueList);
			if (valueIndex < values.length - 1) {
				valuesSqlList.push(sql`, `);
			}
		});

		const valuesSql = sql.fromList(valuesSqlList);

		const returningSql = returning
			? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}`
			: undefined;

		const onConflictSql = onConflict ? sql` on conflict ${onConflict}` : undefined;

		return sql`insert into ${table} ${insertOrder} values ${valuesSql}${onConflictSql}${returningSql}`;
	}

	prepareSQL(sql: SQL): PreparedQuery {
		return sql.toQuery({
			escapeName: this.escapeName,
			escapeParam: this.escapeParam,
		});
	}
}