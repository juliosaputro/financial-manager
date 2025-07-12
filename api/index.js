import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { kv } from '@vercel/kv';
import { body, validationResult } from 'express-validator';

// Load environment variables
dotenv.config();

const app = express();

// Middlewares
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Enable JSON body parsing

// --- Constants for KV Keys ---
const TRANSACTIONS_IDS_KEY = 'transaction_ids';
const CATEGORIES_IDS_KEY = 'category_ids';

// Helper to create prefixed keys
const transactionKey = (id) => `transaction:${id}`;
const categoryKey = (id) => `category:${id}`;

// --- Validation Middlewares ---
const transactionValidationRules = () => {
  return [
    body('description').trim().notEmpty().withMessage('Deskripsi tidak boleh kosong.'),
    body('amount').isFloat({ gt: 0 }).withMessage('Jumlah harus angka dan lebih besar dari 0.'),
    body('type').isIn(['Income', 'Expense']).withMessage("Tipe harus 'Income' atau 'Expense'."),
    body('date').isISO8601().toDate().withMessage('Format tanggal tidak valid (gunakan YYYY-MM-DD).'),
    body('category').trim().notEmpty().withMessage('Kategori tidak boleh kosong.'),
  ];
};

const categoryValidationRules = () => {
  return [
    body('name')
      .trim()
      .notEmpty().withMessage('Nama kategori tidak boleh kosong.')
      .custom(async (name, { req }) => {
        // Fetch categories from KV to check for uniqueness
        const categoryIds = await kv.smembers(CATEGORIES_IDS_KEY);
        const categoryId = req.params.id ? parseInt(req.params.id, 10) : null;
        const keys = categoryIds.map(id => categoryKey(id));
        const categories = categoryIds.length ? (await kv.mget(...keys)) : [];
        const existingCategory = categories.find(
          c => c.name.toLowerCase() === name.toLowerCase() && c.id !== categoryId
        );
        if (existingCategory) {
          return Promise.reject('Nama kategori sudah digunakan.');
        }
      }),
    body('color')
      .trim()
      .notEmpty().withMessage('Warna tidak boleh kosong.')
      .isHexColor().withMessage('Format warna tidak valid (harus kode hex, cth: #RRGGBB).')
  ];
};

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }
  const extractedErrors = errors.array().map(err => ({ [err.path]: err.msg }));
  return res.status(422).json({ errors: extractedErrors });
};

// =================================================================
// TRANSACTION ROUTES
// =================================================================

/**
 * GET /api/transactions
 * Fetches all transactions with filtering and pagination.
 */
app.get('/api/transactions', async (req, res) => {
  try {
    const { year, month, type, category, search, startDate, endDate, page = 1, limit = 10 } = req.query;
    
    // 1. Get all transaction IDs from the set
    const transactionIds = await kv.smembers(TRANSACTIONS_IDS_KEY);
    if (!transactionIds.length) {
      return res.json({ data: [], pagination: { totalItems: 0, totalPages: 0, currentPage: 1, limit: 10 } });
    }

    // 2. Fetch all transaction objects in one batch
    const keys = transactionIds.map(id => transactionKey(id));
    let transactions = (await kv.mget(...keys)) || [];

    // Apply filters
    if (year) {
      const numericYear = parseInt(year, 10);
      if (!isNaN(numericYear)) {
        transactions = transactions.filter(t => new Date(t.date).getFullYear() === numericYear);
      }
    }
    if (month) {
      const numericMonth = parseInt(month, 10);
      if (!isNaN(numericMonth)) {
        transactions = transactions.filter(t => new Date(t.date).getMonth() === numericMonth - 1);
      }
    }
    if (type) {
      transactions = transactions.filter(t => t.type.toLowerCase() === type.toLowerCase());
    }
    if (category) {
      transactions = transactions.filter(t => t.category.toLowerCase() === category.toLowerCase());
    }
    if (search) {
      transactions = transactions.filter(t => t.description.toLowerCase().includes(search.toLowerCase()));
    }
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      transactions = transactions.filter(t => new Date(t.date) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      transactions = transactions.filter(t => new Date(t.date) <= end);
    }

    // Apply pagination
    const numericPage = parseInt(page, 10);
    const numericLimit = parseInt(limit, 10);
    const totalItems = transactions.length;
    const totalPages = Math.ceil(totalItems / numericLimit);
    const startIndex = (numericPage - 1) * numericLimit;
    const paginatedData = transactions.slice(startIndex, startIndex + numericLimit);

    res.json({
      data: paginatedData,
      pagination: { totalItems, totalPages, currentPage: numericPage, limit: numericLimit },
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ message: 'Error fetching transactions', error: error.message });
  }
});

/**
 * POST /api/transactions
 * Adds a new transaction to Vercel KV.
 */
app.post('/api/transactions', transactionValidationRules(), validate, async (req, res) => {
  try {
    const newId = Date.now();
    const newTransaction = { id: newId, ...req.body };
    const key = transactionKey(newId);

    // Use a pipeline to perform atomic operations
    const pipeline = kv.multi();
    pipeline.sadd(TRANSACTIONS_IDS_KEY, newId); // Add ID to the index set
    pipeline.set(key, newTransaction);         // Set the transaction object
    await pipeline.exec();

    res.status(201).json(newTransaction);
  } catch (error)
  {
    console.error('Error adding transaction:', error);
    res.status(500).json({ message: 'Error adding transaction', error: error.message });
  }
});

/**
 * PUT /api/transactions/:id
 * Updates an existing transaction by its ID in Vercel KV.
 */
app.put('/api/transactions/:id', transactionValidationRules(), validate, async (req, res) => {
  try {
    const transactionId = parseInt(req.params.id, 10);
    const key = transactionKey(transactionId);

    // Validate the ID
    if (isNaN(transactionId)) {
      return res.status(400).json({ message: 'Invalid transaction ID format.' });
    }

    // Check if the transaction ID exists in our index set
    const exists = await kv.sismember(TRANSACTIONS_IDS_KEY, transactionId);
    if (!exists) {
      return res.status(404).json({ message: `Transaction with ID ${transactionId} not found.` });
    }

    // Fetch the specific transaction, update it, and save it back
    const oldTransaction = await kv.get(key);
    const updatedTransaction = { ...oldTransaction, ...req.body, id: transactionId }; // Ensure ID is not overwritten
    await kv.set(key, updatedTransaction);

    res.status(200).json(updatedTransaction);
  } catch (error) {
    console.error('Error updating transaction:', error);
    res.status(500).json({ message: 'Error updating transaction', error: error.message });
  }
});

/**
 * DELETE /api/transactions/:id
 * Deletes a transaction by its ID from Vercel KV.
 */
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const transactionId = parseInt(req.params.id, 10);

    // Validate the ID
    if (isNaN(transactionId)) {
      return res.status(400).json({ message: 'Invalid transaction ID format.' });
    }

    // Use a pipeline to remove the ID from the index and delete the object
    const pipeline = kv.multi();
    pipeline.srem(TRANSACTIONS_IDS_KEY, transactionId); // Remove from index
    pipeline.del(transactionKey(transactionId));        // Delete object
    const [sremResult] = await pipeline.exec();

    // sremResult will be 0 if the ID was not in the set
    if (sremResult === 0) {
      return res.status(404).json({ message: `Transaction with ID ${transactionId} not found.` });
    }

    res.status(204).send(); // 204 No Content
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({ message: 'Error deleting transaction', error: error.message });
  }
});

// =================================================================
// CATEGORY ROUTES
// =================================================================

/**
 * GET /api/categories
 * Fetches all categories with filtering and pagination.
 */
app.get('/api/categories', async (req, res) => {
  try {
    const { name, page = 1, limit = 10 } = req.query;

    const categoryIds = await kv.smembers(CATEGORIES_IDS_KEY);
    if (!categoryIds.length) {
      return res.json({ data: [], pagination: { totalItems: 0, totalPages: 0, currentPage: 1, limit: 10 } });
    }

    const keys = categoryIds.map(id => categoryKey(id));
    let allCategories = (await kv.mget(...keys)) || [];

    // Filter by name (case-insensitive)
    if (name) {
      allCategories = allCategories.filter(c =>
        c.name.toLowerCase().includes(name.toLowerCase())
      );
    }

    // Apply pagination
    const numericPage = parseInt(page, 10);
    const numericLimit = parseInt(limit, 10);
    const totalItems = allCategories.length;
    const totalPages = Math.ceil(totalItems / numericLimit);
    const startIndex = (numericPage - 1) * numericLimit;
    const paginatedData = allCategories.slice(startIndex, startIndex + numericLimit);

    res.json({
      data: paginatedData,
      pagination: { totalItems, totalPages, currentPage: numericPage, limit: numericLimit },
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ message: 'Error fetching categories', error: error.message });
  }
});

/**
 * POST /api/categories
 * Adds a new category.
 */
app.post('/api/categories', categoryValidationRules(), validate, async (req, res) => {
    try {
        const { name, color } = req.body;
        const newId = Date.now();
        const newCategory = { id: newId, name, color };

        const pipeline = kv.multi();
        pipeline.sadd(CATEGORIES_IDS_KEY, newId);
        pipeline.set(categoryKey(newId), newCategory);
        await pipeline.exec();
        
        res.status(201).json(newCategory);
    } catch (error) {
        console.error('Error adding category:', error);
        res.status(500).json({ message: 'Error adding category', error: error.message });
    }
});

/**
 * PUT /api/categories/:id
 * Updates an existing category.
 */
app.put('/api/categories/:id', categoryValidationRules(), validate, async (req, res) => {
    try {
        const categoryId = parseInt(req.params.id, 10);
        const key = categoryKey(categoryId);

        const exists = await kv.sismember(CATEGORIES_IDS_KEY, categoryId);
        if (!exists) {
            return res.status(404).json({ message: `Category with ID ${categoryId} not found.` });
        }

        const oldCategory = await kv.get(key);
        const updatedCategory = { ...oldCategory, ...req.body, id: categoryId };
        await kv.set(key, updatedCategory);

        res.status(200).json(updatedCategory);
    } catch (error) {
        console.error('Error updating category:', error);
        res.status(500).json({ message: 'Error updating category', error: error.message });
    }
});

/**
 * DELETE /api/categories/:id
 * Deletes a category by its ID.
 */
app.delete('/api/categories/:id', async (req, res) => {
    try {
        const categoryId = parseInt(req.params.id, 10);

        const pipeline = kv.multi();
        pipeline.srem(CATEGORIES_IDS_KEY, categoryId);
        pipeline.del(categoryKey(categoryId));
        const [sremResult] = await pipeline.exec();

        if (sremResult === 0) {
            return res.status(404).json({ message: `Category with ID ${categoryId} not found.` });
        }

        res.status(204).send();
    } catch (error) {
        console.error('Error deleting category:', error);
        res.status(500).json({ message: 'Error deleting category', error: error.message });
    }
});

// =================================================================
// SUMMARY ROUTE
// =================================================================

const filterTransactionsByPeriod = (transactions, { year, month, startDate, endDate }) => {
  let filtered = [...transactions];

  if (startDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    filtered = filtered.filter(t => new Date(t.date) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filtered = filtered.filter(t => new Date(t.date) <= end);
  }

  // Filter year/month only if startDate is not present
  if (!startDate && year) {
    filtered = filtered.filter(t => new Date(t.date).getFullYear() === year);
    if (month) {
      filtered = filtered.filter(t => new Date(t.date).getMonth() === month - 1);
    }
  }
  return filtered;
};

app.get('/api/summary', async (req, res) => {
  try {
    const { year, month, startDate, endDate } = req.query;

    const transactionIds = await kv.smembers(TRANSACTIONS_IDS_KEY);
    if (!transactionIds.length) {
      return res.json({ totalIncome: 0, totalExpense: 0, totalBalance: 0 });
    }
    const keys = transactionIds.map(id => transactionKey(id));
    const allTransactions = (await kv.mget(...keys)) || [];

    const numericYear = year ? parseInt(year, 10) : new Date().getFullYear();
    const numericMonth = month ? parseInt(month, 10) : null;
    const filtered = filterTransactionsByPeriod(allTransactions, { year: numericYear, month: numericMonth, startDate, endDate });

    const totalIncome = filtered.filter(t => t.type === 'Income').reduce((acc, t) => acc + t.amount, 0);
    const totalExpense = filtered.filter(t => t.type === 'Expense').reduce((acc, t) => acc + t.amount, 0);
    const totalBalance = totalIncome - totalExpense;

    res.json({ totalIncome, totalExpense, totalBalance });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ message: 'Error fetching summary', error: error.message });
  }
});

// Export the app for Vercel
export default app;