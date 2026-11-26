import { createHandler } from 'next-cache-s3'
import { storage } from './storage.mjs'

export default createHandler({ name: 'sticky', storage, sticky: true })
