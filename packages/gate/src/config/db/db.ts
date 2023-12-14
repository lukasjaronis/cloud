import { drizzle, PlanetScaleDatabase } from 'drizzle-orm/planetscale-serverless'
import { connect } from '@planetscale/database'
import { ENV } from '../env'
import { schema } from '.'

export class Database {
  db: PlanetScaleDatabase<typeof schema>

  constructor(env: ENV) {
    const connection = connect({
      host: env.PLANETSCALE_HOST,
      username: env.PLANETSCALE_USERNAME,
      password: env.PLANETSCALE_PASSWORD,
      fetch(input, init) {
        delete (init as RequestInit)['cache']
        return fetch(input, init)
      },
    })

    this.db = drizzle(connection, { schema })
  }
}