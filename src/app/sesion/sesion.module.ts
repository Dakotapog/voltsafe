import { IonicModule } from '@ionic/angular';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SesionPage } from './sesion.page';
import { SesionPageRoutingModule } from './sesion-routing.module';
import { BriSeismographComponent } from './bri-seismograph.component';

@NgModule({
  imports: [IonicModule, CommonModule, FormsModule, SesionPageRoutingModule, BriSeismographComponent],
  declarations: [SesionPage],
})
export class SesionPageModule {}
