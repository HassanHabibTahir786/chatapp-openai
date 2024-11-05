export const serverError = (err, _req, res, _next) => {
    if (!err.status) {
      console.error(err.stack);
    }
    res
      .status(err.status || 500)
      .json({ message: err.message || "Internal Server Error" });
  
    if (err.name === "ValidationError") {
      const message = Object.values(err.errors).map((val) => val.message);
      error = new ErrorResponse(message, 400);
    }
  };
  
  export const catchAsync = (handler) => (req, res, next) => {
    try {
      const result = handler(req, res, next);
  
      return result.catch((error) => {
        if (error.name === "ValidationError") {
          // Mongoose validation error
          const message = Object.values(error?.errors).map((val) => val?.message);
  
          return res.status(422).json({
            message: message ? message[0] : "",
          });
        }
  
        next(error); // Pass the error to the next middleware or error handler
      });
    } catch (err) {
      next(err)
    }
  };
  