import { createError } from "../utils/error.utils.js"

export const validateRequest = (schema) => {
  return (req, res, next) => {
    try {
      const payload = {
        body: req.body,
        params: req.params,
        query: req.query,
      }

      const expectsRequestShape =
        schema &&
        schema._def &&
        schema._def.shape &&
        (Object.prototype.hasOwnProperty.call(schema._def.shape(), "body") ||
          Object.prototype.hasOwnProperty.call(schema._def.shape(), "params") ||
          Object.prototype.hasOwnProperty.call(schema._def.shape(), "query"))

      const result = expectsRequestShape ? schema.safeParse(payload) : schema.safeParse(req.body)

      if (!result.success) {
        const errors = result.error.errors.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        }))

        return next(createError(400, "Validation failed", errors))
      }

      if (expectsRequestShape) {
        if (result.data.body) {
          req.body = result.data.body
        }
        if (result.data.params) {
          req.params = result.data.params
        }
        if (result.data.query) {
          req.query = result.data.query
        }
      } else {
        req.body = result.data
      }

      next()
    } catch (error) {
      next(createError(500, "Validation error"))
    }
  }
}