import { Controller, Get, Post, Delete, Param, Body, Query, Request, UseGuards, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiService } from '../api/api.service.js';

@Controller('api/v1/admin/finance')
@UseGuards(AuthGuard('jwt'))
export class AdminFinanceController {
  constructor(private readonly apiService: ApiService) {}

  private checkAdmin(req: any) {
    const role = req.user?.role;
    if (role !== 'Owner' && role !== 'Admin') {
      throw new UnauthorizedException('Administrative privileges required.');
    }
  }

  // Expenses
  @Get('expenses')
  async getExpenses(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search: string,
    @Request() req: any
  ) {
    this.checkAdmin(req);
    const pNum = page ? parseInt(page, 10) : undefined;
    const lNum = limit ? parseInt(limit, 10) : undefined;
    if (pNum || lNum || search) {
      return this.apiService.getPaginatedExpenses({ page: pNum, limit: lNum, search });
    }
    return this.apiService.getExpenses();
  }

  @Post('expenses')
  async addExpense(@Body() exp: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addExpense(exp, req.user.email, req.ip);
  }

  @Delete('expenses/:id')
  async deleteExpense(@Param('id') id: string, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.softDeleteExpense(id, req.user.email, req.ip);
  }

  // Distributors
  @Get('distributors')
  async getDistributors(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSuppliers();
  }

  @Post('distributors')
  async createDistributor(@Body() body: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.createSupplier(body, req.user.email, req.ip);
  }

  // Splits
  @Get('splits')
  async getSplits(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getSplits();
  }

  @Post('splits/settle')
  async addSettlement(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    const { from, to, amount, notes, date } = dto;
    return this.apiService.addSettlement(from, to, Number(amount), notes, date);
  }

  // Cash Accounts
  @Get('cash-accounts')
  async getCashAccounts(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getCashAccounts();
  }

  @Post('cash-accounts')
  async createCashAccount(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    const { name, type, openingBalance, currency, description } = dto;
    return this.apiService.createCashAccount(name, type, Number(openingBalance), currency, description);
  }

  // Cash Ledger
  @Get('cash-ledger')
  async getCashLedger(
    @Query('timeRange') timeRange?: string,
    @Query('cashAccountId') cashAccountId?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Request() req?: any
  ) {
    this.checkAdmin(req);
    return this.apiService.getCashLedger({
      timeRange,
      cashAccountId,
      type,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined
    });
  }

  @Post('cash-ledger/adjust')
  async addLedgerAdjustment(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addLedgerAdjustment(dto, req.user.email, req.ip);
  }

  // Founder Ledger
  @Get('founder-ledger')
  async getFounderLedger(@Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.getFounderLedger();
  }

  @Post('founder-ledger/contribute')
  async addFounderContribution(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addFounderContribution(dto, req.user.email, req.ip);
  }

  @Post('founder-ledger/reimburse')
  async addFounderReimbursement(@Body() dto: any, @Request() req: any) {
    this.checkAdmin(req);
    return this.apiService.addFounderReimbursement(dto, req.user.email, req.ip);
  }
}
export default AdminFinanceController;
